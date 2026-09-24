import type { Pool } from 'pg'
import type { ReconciliationFinding } from '../domain/reconciliation.js'
import type { DebitReconciliationItem, ExaminedRef, PayoutObservationInput, ReconciliationRepository, ServiceRefundReconciliationItem, TransferReconciliationItem } from '../ports/settlement-ops.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PostgresReconciliationRepository implements ReconciliationRepository {
  public constructor(private readonly pool: Pool) {}

  public async startRun(now: Date): Promise<string> {
    const result = await this.pool.query<{ id: string }>("insert into settlement_reconciliation_runs(started_at) values($1::timestamptz) returning id", [now])
    return result.rows[0]!.id
  }

  public async finishRun(input: { runId: string; status: 'completed' | 'failed'; checked: number; discrepancies: number; summary: Record<string, number>; now: Date }): Promise<void> {
    await this.pool.query(
      'update settlement_reconciliation_runs set status = $2, finished_at = $3::timestamptz, checked_count = $4, discrepancy_count = $5, summary = $6::jsonb, updated_at = now() where id = $1::uuid',
      [input.runId, input.status, input.now, input.checked, input.discrepancies, JSON.stringify(input.summary)]
    )
  }

  public async lastCompletedRunAt(): Promise<Date | null> {
    const result = await this.pool.query<{ at: Date | null }>("select max(finished_at) as at from settlement_reconciliation_runs where status = 'completed'")
    return result.rows[0]?.at ?? null
  }

  public async loadDebits(input: { now: Date; sinceDays: number; limit: number }): Promise<DebitReconciliationItem[]> {
    const result = await this.pool.query<{ id: string; status: DebitReconciliationItem['db']['status']; amount: string; pi: string | null; charge: string | null; livemode: boolean; age: string; known_refunds: string }>(
      `select a.id, a.status, a.amount_cents::text as amount, a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge, a.livemode, (extract(epoch from ($1::timestamptz - a.created_at)) / 60)::text as age,
              (select coalesce(sum(sr.refund_cents), 0) from driver_reversal_service_refunds sr where sr.debit_attempt_id = a.id and sr.status = 'succeeded')::text as known_refunds
         from debit_attempts a where a.created_at >= $1::timestamptz - make_interval(days => $2) order by a.created_at desc limit $3`,
      [input.now, input.sinceDays, input.limit]
    )
    return result.rows.map((r) => ({ db: { id: r.id, status: r.status, amountCents: Number(r.amount), paymentIntentId: r.pi, chargeId: r.charge, livemode: r.livemode, ageMinutes: Math.max(0, Math.floor(Number(r.age))) }, knownServiceRefundCents: Number(r.known_refunds) }))
  }

  private async transfers(where: string, params: unknown[]): Promise<TransferReconciliationItem[]> {
    const result = await this.pool.query<{ id: string; status: TransferReconciliationItem['db']['status']; amount: string; stripe_id: string | null; destination: string | null; charge: string; livemode: boolean; age: string; reversed: string }>(
      `select t.id, t.status, t.amount_cents::text as amount, t.stripe_transfer_id as stripe_id, t.destination_account_id as destination, t.stripe_charge_id as charge, t.livemode,
              (extract(epoch from ($1::timestamptz - t.created_at)) / 60)::text as age,
              (select coalesce(sum(r.reversed_cents), 0) from driver_transfer_reversals r where r.driver_transfer_id = t.id and r.status = 'succeeded')::text as reversed
         from driver_transfers t where ${where}`,
      params
    )
    return result.rows.map((r) => ({
      db: { id: r.id, status: r.status, amountCents: Number(r.amount), stripeTransferId: r.stripe_id, destinationAccountId: r.destination, chargeId: r.charge, livemode: r.livemode, ageMinutes: Math.max(0, Math.floor(Number(r.age))) },
      ledgerReversedCents: Number(r.reversed)
    }))
  }

  public loadTransfers(input: { now: Date; sinceDays: number; limit: number }): Promise<TransferReconciliationItem[]> {
    return this.transfers('t.created_at >= $1::timestamptz - make_interval(days => $2) order by t.created_at desc limit $3', [input.now, input.sinceDays, input.limit])
  }

  public async loadServiceRefunds(input: { now: Date; sinceDays: number; limit: number }): Promise<ServiceRefundReconciliationItem[]> {
    const result = await this.pool.query<{ id: string; status: ServiceRefundReconciliationItem['db']['status']; refund_id: string | null; charge: string; amount: string; livemode: boolean }>(
      `select id, status, stripe_refund_id as refund_id, stripe_charge_id as charge, refund_cents::text as amount, livemode from driver_reversal_service_refunds
       where created_at >= $1::timestamptz - make_interval(days => $2) order by created_at desc limit $3`, [input.now, input.sinceDays, input.limit]
    )
    return result.rows.map((r) => ({ db: { id: r.id, status: r.status, stripeRefundId: r.refund_id, chargeId: r.charge, refundCents: Number(r.amount), livemode: r.livemode } }))
  }

  public async loadTransferByStripeId(stripeTransferId: string, now: Date): Promise<TransferReconciliationItem | null> {
    return (await this.transfers('t.stripe_transfer_id = $2', [now, stripeTransferId]))[0] ?? null
  }

  public async knownDriverTransferIds(ids: string[]): Promise<Set<string>> {
    const valid = ids.filter((id) => UUID.test(id))
    if (valid.length === 0) return new Set()
    const result = await this.pool.query<{ id: string }>('select id from driver_transfers where id = any($1::uuid[])', [valid])
    return new Set(result.rows.map((r) => r.id))
  }

  public async loadDriverAccounts(): Promise<Array<{ driverId: string; stripeAccountId: string; openReceivablesCents: number; livemode: boolean }>> {
    const result = await this.pool.query<{ driver_id: string; stripe_account_id: string; open: string; livemode: boolean }>(
      `select ca.driver_id, ca.stripe_account_id, ca.livemode, coalesce((select sum(r.amount_cents) from driver_receivables r where r.driver_id = ca.driver_id and r.status = 'open'), 0)::text as open
         from driver_connect_accounts ca where exists (select 1 from driver_transfers t join settlement_statements st on st.id = t.statement_id where st.driver_id = ca.driver_id)`
    )
    return result.rows.map((r) => ({ driverId: r.driver_id, stripeAccountId: r.stripe_account_id, openReceivablesCents: Number(r.open), livemode: r.livemode }))
  }

  public async recordFindings(input: { runId: string | null; findings: ReconciliationFinding[]; examined: ExaminedRef[]; now: Date }): Promise<{ opened: number; stillOpen: number; resolved: number }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      let opened = 0
      let stillOpen = 0
      for (const f of input.findings) {
        const result = await client.query<{ inserted: boolean }>(
          `insert into settlement_reconciliation_findings(run_id, last_run_id, kind, scope, ref_type, ref_id, expected_cents, actual_cents, details, last_seen_at)
           values($1::uuid, $1::uuid, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::jsonb, $9::timestamptz)
           on conflict (kind, ref_type, ref_id) where resolved_at is null
           do update set scope = excluded.scope, expected_cents = excluded.expected_cents, actual_cents = excluded.actual_cents, details = excluded.details, last_run_id = excluded.last_run_id, last_seen_at = excluded.last_seen_at, updated_at = now()
           returning (xmax = 0) as inserted`,
          [input.runId, f.kind, f.scope, f.refType, f.refId, f.expectedCents, f.actualCents, JSON.stringify(f.details), input.now]
        )
        if (result.rows[0]?.inserted === true) opened += 1
        else stillOpen += 1
      }
      const resolved = await client.query(
        `update settlement_reconciliation_findings f set resolved_at = $6::timestamptz, updated_at = now()
          where f.resolved_at is null
            and exists (select 1 from unnest($1::text[], $2::text[]) as e(t, i) where e.t = f.ref_type and e.i = f.ref_id)
            and not exists (select 1 from unnest($3::text[], $4::text[], $5::text[]) as c(k, t, i) where c.k = f.kind and c.t = f.ref_type and c.i = f.ref_id)`,
        [input.examined.map((e) => e.refType), input.examined.map((e) => e.refId), input.findings.map((f) => f.kind), input.findings.map((f) => f.refType), input.findings.map((f) => f.refId), input.now]
      )
      await client.query('commit')
      return { opened, stillOpen, resolved: resolved.rowCount ?? 0 }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  public async upsertPayouts(observations: PayoutObservationInput[], now: Date): Promise<number> {
    let count = 0
    for (const o of observations) {
      const result = await this.pool.query(
        `insert into driver_payout_observations(driver_id, stripe_account_id, stripe_payout_id, amount_cents, status, automatic, arrival_date, observed_at, livemode)
         values($1::uuid, $2, $3, $4::bigint, $5, $6, $7::date, $8::timestamptz, $9)
         on conflict (stripe_payout_id) do update set amount_cents = excluded.amount_cents, status = excluded.status, arrival_date = excluded.arrival_date, observed_at = excluded.observed_at, updated_at = now()`,
        [o.driverId, o.stripeAccountId, o.payoutId, o.amountCents, o.status, o.automatic, o.arrivalDate, now, o.livemode]
      )
      count += result.rowCount ?? 0
    }
    return count
  }
}
