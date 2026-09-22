import type { Pool, PoolClient } from 'pg'
import type { StatementStatus } from '../domain/statement-status.js'
import type { BeginTransferInput, DriverPayoutRepository, PayoutCandidate, PayRunWork } from '../ports/driver-payout.js'

type RunRow = { id: string; period_id: string; driver_id: string; run_kind: 'grouped' | 'drip'; scheduled_for: Date; period_start: Date; period_end: Date }

/**
 * Paiement des livreurs (R60). Une ligne `driver_transfers` `creating` est COMMITÉE avant tout appel Stripe ; un Transfer réussi, le
 * `paid_cents` et le statut de son statement changent dans la MÊME transaction (contrainte différée `paid_cents = Σ Transfers réussis`).
 * Aucun appel réseau ici.
 */
export class PostgresDriverPayoutRepository implements DriverPayoutRepository {
  public constructor(private readonly pool: Pool) {}

  public async ensureRuns(now: Date): Promise<number> {
    const grouped = await this.pool.query(
      `insert into driver_pay_runs(period_id, driver_id, run_kind, scheduled_for)
       select st.period_id, st.driver_id, 'grouped', sp.payrun_at
         from settlement_statements st join settlement_periods sp on sp.id = st.period_id
        where sp.status = 'closed' and sp.payrun_at is not null and sp.payrun_at <= $1::timestamptz and st.due_cents > st.paid_cents
        group by st.period_id, st.driver_id, sp.payrun_at
       on conflict do nothing`,
      [now]
    )
    const drip = await this.pool.query(
      `insert into driver_pay_runs(period_id, driver_id, run_kind, scheduled_for)
       select st.period_id, st.driver_id, 'drip', $1::timestamptz
         from settlement_statements st join settlement_periods sp on sp.id = st.period_id
        where sp.status = 'closed' and sp.payrun_at <= $1::timestamptz and st.due_cents > st.paid_cents
          and exists (select 1 from driver_pay_runs g where g.period_id = st.period_id and g.driver_id = st.driver_id and g.run_kind = 'grouped')
          and (
            exists (select 1 from driver_transfers t where t.statement_id = st.id and t.status in ('creating','unknown'))
            or (
              exists (select 1 from debit_attempts a where a.merchant_settlement_id = st.merchant_settlement_id and a.status = 'succeeded')
              and (st.payout_next_attempt_at is null or st.payout_next_attempt_at <= $1::timestamptz)
              and exists (select 1 from driver_connect_accounts ca where ca.driver_id = st.driver_id and ca.transfers_status = 'active')
            )
          )
        group by st.period_id, st.driver_id
       on conflict do nothing`,
      [now]
    )
    return (grouped.rowCount ?? 0) + (drip.rowCount ?? 0)
  }

  public async claimRuns(input: { now: Date; limit: number; leaseSeconds: number; workerId: string }): Promise<PayRunWork[]> {
    const result = await this.pool.query<RunRow>(
      `with due as (
         select id from driver_pay_runs
          where (status = 'pending' and scheduled_for <= $1::timestamptz) or (status = 'running' and lease_expires_at < now())
          order by scheduled_for, id limit $2 for update skip locked
       ), claimed as (
         update driver_pay_runs r set status = 'running', claimed_by = $3, lease_expires_at = now() + make_interval(secs => $4), started_at = coalesce(r.started_at, $1::timestamptz), updated_at = now()
           from due where r.id = due.id returning r.*
       ) select c.id, c.period_id, c.driver_id, c.run_kind, c.scheduled_for, sp.period_start, sp.period_end
           from claimed c join settlement_periods sp on sp.id = c.period_id order by c.scheduled_for, c.id`,
      [input.now, input.limit, input.workerId, input.leaseSeconds]
    )
    return result.rows.map((row) => ({ id: row.id, periodId: row.period_id, driverId: row.driver_id, kind: row.run_kind, scheduledFor: row.scheduled_for, periodStart: row.period_start, periodEnd: row.period_end }))
  }

  public async listCandidates(run: { periodId: string; driverId: string }, now: Date): Promise<PayoutCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `select st.id, st.period_id, st.driver_id, st.merchant_settlement_id, st.due_cents::text as due, st.paid_cents::text as paid, sp.payrun_at,
              d.id as debit_id, d.status as debit_status, d.stripe_payment_intent_id, d.stripe_charge_id, d.amount_cents::text as debit_amount, d.livemode as debit_livemode,
              exists (select 1 from debit_incidents i where i.debit_attempt_id = d.id and i.status in ('open','lost')) as debit_incident,
              coalesce((select sum(t.amount_cents) from driver_transfers t where t.debit_attempt_id = d.id and t.status in ('creating','succeeded','unknown')), 0)::text as already,
              ca.stripe_account_id, ca.transfers_status, ca.requirements_state, ca.restricted_at, ca.livemode as account_livemode,
              ot.id as ot_id, ot.try_no as ot_try, ot.idempotency_key as ot_key, ot.amount_cents::text as ot_amount, ot.stripe_charge_id as ot_charge, ot.debit_attempt_id as ot_debit, ot.created_at as ot_created,
              coalesce((select max(t.try_no) from driver_transfers t where t.statement_id = st.id and t.debit_attempt_id = d.id), 0) as last_try,
              (select count(*) from driver_transfers t where t.statement_id = st.id and t.debit_attempt_id = d.id and t.status = 'failed')::int as failed_tries
         from settlement_statements st
         join settlement_periods sp on sp.id = st.period_id
         left join lateral (select * from debit_attempts a where a.merchant_settlement_id = st.merchant_settlement_id order by (a.status = 'succeeded') desc, a.attempt_no desc limit 1) d on true
         left join driver_connect_accounts ca on ca.driver_id = st.driver_id
         left join lateral (select * from driver_transfers t where t.statement_id = st.id and t.status in ('creating','unknown') order by t.created_at desc limit 1) ot on true
        where st.period_id = $1::uuid and st.driver_id = $2::uuid and st.due_cents > st.paid_cents
          and (ot.id is not null or st.payout_next_attempt_at is null or st.payout_next_attempt_at <= $3::timestamptz)
        order by st.created_at, st.id`,
      [run.periodId, run.driverId, now]
    )
    return result.rows.map((r) => ({
      statementId: r.id as string,
      periodId: r.period_id as string,
      driverId: r.driver_id as string,
      merchantSettlementId: r.merchant_settlement_id as string,
      dueCents: Number(r.due),
      paidCents: Number(r.paid),
      payrunAt: r.payrun_at as Date,
      debit: r.debit_id === null ? null : { id: r.debit_id as string, status: r.debit_status as 'succeeded', paymentIntentId: r.stripe_payment_intent_id as string | null, chargeId: r.stripe_charge_id as string | null, amountCents: Number(r.debit_amount), livemode: r.debit_livemode as boolean, incidentOpen: r.debit_incident as boolean },
      alreadyTransferredFromDebitCents: Number(r.already),
      driverAccount: r.stripe_account_id === null ? null : {
        stripeAccountId: r.stripe_account_id as string,
        transfersReadyLocally: r.transfers_status === 'active' && r.requirements_state !== 'disabled' && r.requirements_state !== 'past_due' && r.restricted_at === null,
        livemode: r.account_livemode as boolean
      },
      openTransfer: r.ot_id === null ? null : { id: r.ot_id as string, tryNo: r.ot_try as number, idempotencyKey: r.ot_key as string, amountCents: Number(r.ot_amount), chargeId: r.ot_charge as string, debitAttemptId: r.ot_debit as string, createdAt: r.ot_created as Date },
      lastTryNo: Number(r.last_try),
      failedTries: r.failed_tries as number
    }))
  }

  public async beginTransfer(input: BeginTransferInput): Promise<{ outcome: 'created'; transferId: string } | { outcome: 'refused' }> {
    try {
      const result = await this.pool.query<{ id: string }>(
        `insert into driver_transfers(statement_id, pay_run_id, debit_attempt_id, stripe_charge_id, destination_account_id, amount_cents, funding_mode, try_no, idempotency_key, status, livemode)
         values($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, 'source_transaction', $7::int, $8, 'creating', $9) returning id`,
        [input.statementId, input.payRunId, input.debitAttemptId, input.chargeId, input.destinationAccountId, input.amountCents, input.tryNo, input.idempotencyKey, input.livemode]
      )
      return { outcome: 'created', transferId: result.rows[0]!.id }
    } catch (error) {
      const code = (error as { code?: string }).code
      // P0001 = garde de base (débit non réussi, avant payrun_at, plafonds, destination) ; 23505 = un autre worker a déjà ouvert ce Transfer.
      if (code === 'P0001' || code === '23505') return { outcome: 'refused' }
      throw error
    }
  }

  public async completeTransfer(input: { transferId: string; stripeTransferId: string; destinationPaymentId: string | null; now: Date }): Promise<'completed' | 'already_final'> {
    return this.inTransaction(async (client) => {
      const updated = await client.query<{ statement_id: string }>(
        `update driver_transfers set status = 'succeeded', stripe_transfer_id = $2, stripe_destination_payment_id = $3, succeeded_at = $4::timestamptz, submitted_at = coalesce(submitted_at, $4::timestamptz), updated_at = now()
          where id = $1 and status in ('creating','unknown') returning statement_id`,
        [input.transferId, input.stripeTransferId, input.destinationPaymentId, input.now]
      )
      const statementId = updated.rows[0]?.statement_id
      if (statementId === undefined) return 'already_final' as const
      await client.query(
        `with s as (select coalesce(sum(amount_cents), 0) as paid from driver_transfers where statement_id = $1 and status = 'succeeded')
         update settlement_statements st set paid_cents = s.paid, status = case when s.paid = st.due_cents then 'paid' else 'partial' end,
                payout_hold_reason = null, payout_next_attempt_at = null, updated_at = now()
           from s where st.id = $1`,
        [statementId]
      )
      return 'completed' as const
    })
  }

  public async markTransferUnknown(transferId: string, now: Date): Promise<void> {
    await this.pool.query("update driver_transfers set status = 'unknown', submitted_at = coalesce(submitted_at, $2::timestamptz), updated_at = now() where id = $1 and status in ('creating','unknown')", [transferId, now])
  }

  public async failTransfer(input: { transferId: string; code: string; now: Date; retryAfterSeconds: number | null; statementStatus: StatementStatus | null; holdReason: string }): Promise<void> {
    await this.inTransaction(async (client) => {
      const updated = await client.query<{ statement_id: string }>(
        "update driver_transfers set status = 'failed', failure_code = $2, failed_at = $3::timestamptz, updated_at = now() where id = $1 and status in ('creating','unknown') returning statement_id",
        [input.transferId, input.code, input.now]
      )
      const statementId = updated.rows[0]?.statement_id
      if (statementId === undefined) return
      await client.query(
        `update settlement_statements set status = coalesce($2::text, status), payout_hold_reason = $3,
                payout_next_attempt_at = case when $4::int is null then 'infinity'::timestamptz else $5::timestamptz + make_interval(secs => $4::int) end, updated_at = now()
          where id = $1 and status <> 'paid'`,
        [statementId, input.statementStatus, input.holdReason, input.retryAfterSeconds, input.now]
      )
    })
  }

  public async setStatementHold(input: { statementId: string; status: StatementStatus; holdReason: string | null; nextAttemptAt: Date | null }): Promise<void> {
    await this.pool.query(
      `update settlement_statements set status = $2, payout_hold_reason = $3, payout_next_attempt_at = $4::timestamptz, updated_at = now()
        where id = $1 and status <> 'paid' and (status, payout_hold_reason, payout_next_attempt_at) is distinct from ($2::text, $3::text, $4::timestamptz)`,
      [input.statementId, input.status, input.holdReason, input.nextAttemptAt]
    )
  }

  public async finishRun(input: { runId: string; total: number; paid: number; amountCents: number; now: Date }): Promise<void> {
    await this.pool.query(
      `update driver_pay_runs set status = 'completed', completed_at = $5::timestamptz, claimed_by = null, lease_expires_at = null,
              statements_total = statements_paid + $2::int, statements_paid = statements_paid + $3::int, amount_cents = amount_cents + $4::bigint, updated_at = now()
        where id = $1 and status = 'running'`,
      [input.runId, input.total, input.paid, input.amountCents, input.now]
    )
  }

  public async listUnannotated(limit: number): Promise<Array<{ transferId: string; statementId: string; destinationAccountId: string; destinationPaymentId: string; periodStart: Date; periodEnd: Date }>> {
    const result = await this.pool.query<{ id: string; statement_id: string; destination_account_id: string; stripe_destination_payment_id: string; period_start: Date; period_end: Date }>(
      `select t.id, t.statement_id, t.destination_account_id, t.stripe_destination_payment_id, sp.period_start, sp.period_end
         from driver_transfers t join settlement_statements st on st.id = t.statement_id join settlement_periods sp on sp.id = st.period_id
        where t.status = 'succeeded' and t.annotated_at is null and t.stripe_destination_payment_id is not null and t.destination_account_id is not null
        order by t.succeeded_at limit $1`,
      [limit]
    )
    return result.rows.map((row) => ({ transferId: row.id, statementId: row.statement_id, destinationAccountId: row.destination_account_id, destinationPaymentId: row.stripe_destination_payment_id, periodStart: row.period_start, periodEnd: row.period_end }))
  }

  public async markAnnotated(transferId: string, now: Date): Promise<void> {
    await this.pool.query('update driver_transfers set annotated_at = $2::timestamptz, updated_at = now() where id = $1', [transferId, now])
  }

  private async inTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const value = await body(client)
      await client.query('commit')
      return value
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
