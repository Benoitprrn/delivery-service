import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ReversalPlan, ReversalReasonCode, ReversalRequest } from '../domain/reversal-decision.js'
import { ReversalApproverError } from '../domain/errors.js'
import type { ReversalCategory } from '../domain/reversal.js'
import { clampAttributedReversalCents, computeCumulativeServiceRefundCents, isServiceRefundEligible } from '../domain/service-refund.js'
import type { DriverReversalRepository, RequestReversalResult, ReversalRecord, ReversalWork } from '../ports/driver-reversal.js'

type RecordRow = { id: string; driver_transfer_id: string; category: ReversalCategory; reason_code: ReversalReasonCode; reason: string; decision_reference: string; amount_cents: string; order_id: string | null; requested_by: string; approved_by: string | null; status: ReversalRecord['status']; reversed_cents: string | null; planned_reverse_cents: string | null; planned_receivable_cents: string | null; stripe_reversal_id: string | null; failure_code: string | null }
const RECORD_COLUMNS = 'id, driver_transfer_id, category, reason_code, reason, decision_reference, amount_cents::text as amount_cents, order_id, requested_by, approved_by, status, reversed_cents::text as reversed_cents, planned_reverse_cents::text as planned_reverse_cents, planned_receivable_cents::text as planned_receivable_cents, stripe_reversal_id, failure_code'
const WORK_SELECT = `c.id, c.attempt_count, c.claim_token, c.driver_transfer_id, t.stripe_transfer_id, t.amount_cents::text as transfer_amount, t.destination_account_id, t.stripe_charge_id, a.available_on, t.livemode,
  st.driver_id, st.id as statement_id, c.amount_cents::text as amount_cents, c.category, c.reason_code, c.reason, c.decision_reference, c.order_id, c.idempotency_key,
  (select coalesce(sum(x.reversed_cents), 0) from driver_transfer_reversals x where x.driver_transfer_id = c.driver_transfer_id and x.status = 'succeeded' and x.id <> c.id)::text as ledger_reversed,
  c.planned_reverse_cents::text as planned_reverse_cents, c.planned_receivable_cents::text as planned_receivable_cents, c.funds_bucket, c.balance_available_before_cents::text as balance_available_before_cents,
  c.balance_pending_before_cents::text as balance_pending_before_cents, c.stripe_amount_reversed_before_cents::text as stripe_amount_reversed_before_cents, c.stripe_reversal_id`
const num = (value: string | null): number | null => value === null ? null : Number(value)
const toRecord = (row: RecordRow): ReversalRecord => ({
  id: row.id, driverTransferId: row.driver_transfer_id, category: row.category, reasonCode: row.reason_code, reason: row.reason, decisionReference: row.decision_reference, amountCents: Number(row.amount_cents), orderId: row.order_id,
  requestedBy: row.requested_by, approvedBy: row.approved_by, status: row.status, reversedCents: num(row.reversed_cents), plannedReverseCents: num(row.planned_reverse_cents), plannedReceivableCents: num(row.planned_receivable_cents), stripeReversalId: row.stripe_reversal_id, failureCode: row.failure_code
})

type WorkRow = { id: string; attempt_count: number; claim_token: string; driver_transfer_id: string; stripe_transfer_id: string; transfer_amount: string; destination_account_id: string; stripe_charge_id: string; available_on: Date | null; livemode: boolean; driver_id: string; statement_id: string; amount_cents: string; category: ReversalCategory; reason_code: ReversalReasonCode; reason: string; decision_reference: string; order_id: string | null; idempotency_key: string; ledger_reversed: string; planned_reverse_cents: string | null; planned_receivable_cents: string | null; funds_bucket: 'pending' | 'available' | null; balance_available_before_cents: string | null; balance_pending_before_cents: string | null; stripe_amount_reversed_before_cents: string | null; stripe_reversal_id: string | null }

/**
 * Persistance des reversals (R61). La demande, l'approbation et le plan de décision sont des faits figés en base AVANT tout appel Stripe ;
 * la reversal réussie et sa créance `driver_receivable` s'écrivent dans la MÊME transaction. Aucun appel réseau ici.
 */
export class PostgresDriverReversalRepository implements DriverReversalRepository {
  public constructor(private readonly pool: Pool) {}

  public async createRequest(input: ReversalRequest & { driverTransferId: string; requestedBy: string }): Promise<RequestReversalResult> {
    const id = randomUUID()
    // Une demande déjà enregistrée pour cette décision est rendue telle quelle (idempotence) AVANT tout contrôle de plafond : les gardes de base
    // additionneraient sinon le doublon lui-même.
    const found = await this.findExisting(input.driverTransferId, input.decisionReference, input)
    if (found !== null) return found
    try {
      const inserted = await this.pool.query<RecordRow>(
        `insert into driver_transfer_reversals(id, driver_transfer_id, category, reason_code, amount_cents, reason, decision_reference, order_id, requested_by, status, idempotency_key, livemode)
         select $1::uuid, t.id, $3, $4, $5::bigint, $6, $7, $8::uuid, $9::uuid, 'pending_approval', $10, t.livemode from driver_transfers t where t.id = $2::uuid
         on conflict (driver_transfer_id, decision_reference) do nothing
         returning ${RECORD_COLUMNS}`,
        [id, input.driverTransferId, input.category, input.reasonCode, input.amountCents, input.reason, input.decisionReference, input.orderId, input.requestedBy, `reversal:${id}`]
      )
      if (inserted.rows[0] !== undefined) return { outcome: 'created', reversal: toRecord(inserted.rows[0]) }
      return (await this.findExisting(input.driverTransferId, input.decisionReference, input)) ?? { outcome: 'refused', reason: 'transfer_not_reversible' } // transfert inconnu
    } catch (error) {
      if ((error as { code?: string }).code !== 'P0001') throw error
      const message = String((error as { message?: string }).message)
      if (/dépassent le montant/.test(message)) return { outcome: 'refused', reason: 'amount_exceeds_transfer' }
      if (/commande visée/.test(message)) return { outcome: 'refused', reason: 'order_not_in_statement' }
      return { outcome: 'refused', reason: 'transfer_not_reversible' }
    }
  }

  private async findExisting(driverTransferId: string, decisionReference: string, input: ReversalRequest): Promise<RequestReversalResult | null> {
    const existing = await this.pool.query<RecordRow>(`select ${RECORD_COLUMNS} from driver_transfer_reversals where driver_transfer_id = $1::uuid and decision_reference = $2`, [driverTransferId, decisionReference])
    const row = existing.rows[0]
    if (row === undefined) return null
    const same = row.category === input.category && row.reason_code === input.reasonCode && Number(row.amount_cents) === input.amountCents && row.order_id === input.orderId
    return same ? { outcome: 'duplicate', reversal: toRecord(row) } : { outcome: 'conflict' }
  }

  public async approve(input: { reversalId: string; approvedBy: string; now: Date }): Promise<'approved' | 'not_pending' | 'not_found'> {
    try {
      const result = await this.pool.query("update driver_transfer_reversals set status = 'approved', approved_by = $2::uuid, approved_at = $3::timestamptz, updated_at = now() where id = $1::uuid and status = 'pending_approval'", [input.reversalId, input.approvedBy, input.now])
      if (result.rowCount === 1) return 'approved'
    } catch (error) {
      if ((error as { code?: string }).code === '23514') throw new ReversalApproverError() // approved_by <> requested_by (filet de la base)
      throw error
    }
    return (await this.findById(input.reversalId)) === null ? 'not_found' : 'not_pending'
  }

  public async reject(input: { reversalId: string; rejectedBy: string; reason: string; now: Date }): Promise<'rejected' | 'not_pending' | 'not_found'> {
    const result = await this.pool.query("update driver_transfer_reversals set status = 'rejected', rejection_reason = $2, approved_by = null, updated_at = $3::timestamptz where id = $1::uuid and status = 'pending_approval'", [input.reversalId, `${input.reason} (rejected by ${input.rejectedBy})`, input.now])
    if (result.rowCount === 1) return 'rejected'
    return (await this.findById(input.reversalId)) === null ? 'not_found' : 'not_pending'
  }

  public async findById(reversalId: string): Promise<ReversalRecord | null> {
    const result = await this.pool.query<RecordRow>(`select ${RECORD_COLUMNS} from driver_transfer_reversals where id = $1::uuid`, [reversalId])
    return result.rows[0] === undefined ? null : toRecord(result.rows[0])
  }

  public async claimDue(input: { now: Date; limit: number; leaseSeconds: number }): Promise<ReversalWork[]> {
    const candidates = await this.pool.query<{ id: string }>(
      `select id from driver_transfer_reversals
        where status in ('approved','executing') and coalesce(next_attempt_at, '-infinity'::timestamptz) <= $1::timestamptz and (claim_token is null or lease_expires_at < now())
        order by created_at limit $2`,
      [input.now, input.limit]
    )
    const works: ReversalWork[] = []
    for (const candidate of candidates.rows) {
      // Une seule reversal `executing` par livreur (index unique) : une concurrente du même livreur attend son tour au cycle suivant.
      let claimed: WorkRow | undefined
      try {
        claimed = (await this.pool.query<WorkRow>(
          `with c as (
             update driver_transfer_reversals r set status = 'executing', claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $2), attempt_count = r.attempt_count + 1, next_attempt_at = null, updated_at = now()
              where r.id = $1::uuid and r.status in ('approved','executing') and (r.claim_token is null or r.lease_expires_at < now())
                and coalesce(r.next_attempt_at, '-infinity'::timestamptz) <= $3::timestamptz
              returning r.*
           )
           select ${WORK_SELECT} from c
             join driver_transfers t on t.id = c.driver_transfer_id
             join debit_attempts a on a.id = t.debit_attempt_id
             join settlement_statements st on st.id = t.statement_id`,
          [candidate.id, input.leaseSeconds, input.now]
        )).rows[0]
      } catch (error) {
        if ((error as { code?: string }).code === '23505') continue
        throw error
      }
      if (claimed === undefined) continue
      works.push(this.toWork(claimed))
    }
    return works
  }

  private toWork(row: WorkRow): ReversalWork {
    const bucket = row.funds_bucket
    const before = row.stripe_amount_reversed_before_cents
    const balance = bucket === 'available' ? Number(row.balance_available_before_cents) : Number(row.balance_pending_before_cents)
    return {
      id: row.id, attemptCount: row.attempt_count, claimToken: row.claim_token, driverTransferId: row.driver_transfer_id, stripeTransferId: row.stripe_transfer_id, transferAmountCents: Number(row.transfer_amount),
      destinationAccountId: row.destination_account_id, sourceChargeId: row.stripe_charge_id, chargeAvailableOn: row.available_on, livemode: row.livemode, driverId: row.driver_id, statementId: row.statement_id,
      amountCents: Number(row.amount_cents), category: row.category, reasonCode: row.reason_code, reason: row.reason, decisionReference: row.decision_reference, orderId: row.order_id, idempotencyKey: row.idempotency_key,
      ledgerReversedCents: Number(row.ledger_reversed), stripeReversalId: row.stripe_reversal_id,
      plan: row.planned_reverse_cents === null || bucket === null || before === null ? null : {
        reverseNowCents: Number(row.planned_reverse_cents), receivableCents: Number(row.planned_receivable_cents), recoverableCents: Math.max(0, balance), bucket, stripeAmountReversedBeforeCents: Number(before)
      }
    }
  }

  public async persistPlan(input: { reversalId: string; claimToken: string; plan: ReversalPlan; balance: { availableCents: number; pendingCents: number }; stripeAmountReversedBeforeCents: number; now: Date }): Promise<boolean> {
    const result = await this.pool.query(
      `update driver_transfer_reversals
          set planned_reverse_cents = $3::bigint, planned_receivable_cents = $4::bigint, funds_bucket = $5, balance_available_before_cents = $6::bigint, balance_pending_before_cents = $7::bigint,
              stripe_amount_reversed_before_cents = $8::bigint, decided_at = $9::timestamptz, updated_at = now()
        where id = $1::uuid and claim_token = $2::uuid and status = 'executing' and planned_reverse_cents is null`,
      [input.reversalId, input.claimToken, input.plan.reverseNowCents, input.plan.receivableCents, input.plan.bucket, input.balance.availableCents, input.balance.pendingCents, input.stripeAmountReversedBeforeCents, input.now]
    )
    return result.rowCount === 1
  }

  public async complete(input: { reversalId: string; claimToken: string; reversedCents: number; stripeReversalId: string | null; balanceAfter: { availableCents: number; pendingCents: number } | null; now: Date }): Promise<'completed' | 'lost_claim'> {
    return this.inTransaction(async (client) => {
      const updated = await client.query<{ receivable: string; driver_id: string }>(
        `update driver_transfer_reversals r
            set status = 'succeeded', reversed_cents = $3::bigint, stripe_reversal_id = $4, executed_at = $5::timestamptz, balance_available_after_cents = $6::bigint, balance_pending_after_cents = $7::bigint,
                claim_token = null, lease_expires_at = null, next_attempt_at = null, last_error_class = null, updated_at = now()
          where r.id = $1::uuid and r.claim_token = $2::uuid and r.status = 'executing'
          returning r.planned_receivable_cents::text as receivable, (select st.driver_id from driver_transfers t join settlement_statements st on st.id = t.statement_id where t.id = r.driver_transfer_id) as driver_id`,
        [input.reversalId, input.claimToken, input.reversedCents, input.stripeReversalId, input.now, input.balanceAfter?.availableCents ?? null, input.balanceAfter?.pendingCents ?? null]
      )
      const row = updated.rows[0]
      if (row === undefined) return 'lost_claim' as const
      if (Number(row.receivable) > 0) {
        await client.query('insert into driver_receivables(driver_id, driver_transfer_reversal_id, amount_cents) values($1::uuid, $2::uuid, $3::bigint)', [row.driver_id, input.reversalId, row.receivable])
      }
      // SF9.5: this is a downstream, automatic fact of a successful R61 driver-fault reversal. No Stripe call occurs in this transaction.
      const refundSource = await client.query<{ category: ReversalCategory; order_id: string | null; reversed: string; delivery: string; fee: string; previously: string; debit_attempt_id: string; stripe_charge_id: string; livemode: boolean }>(
        `select r.category, r.order_id, r.reversed_cents::text as reversed, o.delivery_cents::text as delivery, o.service_fee_cents::text as fee,
                (select coalesce(sum(previous.reversed_cents), 0) from driver_transfer_reversals previous where previous.order_id = r.order_id and previous.category = 'driver_fault' and previous.status = 'succeeded' and previous.id <> r.id)::text as previously,
                t.debit_attempt_id, t.stripe_charge_id, t.livemode
           from driver_transfer_reversals r join driver_transfers t on t.id = r.driver_transfer_id join orders o on o.id = r.order_id where r.id = $1::uuid`,
        [input.reversalId]
      )
      const source = refundSource.rows[0]
      if (source !== undefined && isServiceRefundEligible({ category: source.category, orderId: source.order_id, reversedCents: Number(source.reversed) })) {
        const reversedCents = clampAttributedReversalCents({ reversedCents: Number(source.reversed), deliveryCents: Number(source.delivery), previouslyRecoveredCents: Number(source.previously) })
        if (reversedCents > 0) {
          const refundCents = computeCumulativeServiceRefundCents({ deliveryCents: Number(source.delivery), serviceFeeCents: Number(source.fee), previouslyRecoveredCents: Number(source.previously), reversedCents })
          await client.query(
            `insert into driver_reversal_service_refunds(driver_transfer_reversal_id, order_id, debit_attempt_id, stripe_charge_id, delivery_cents, service_fee_cents, previously_recovered_cents, reversed_cents, refund_cents, idempotency_key, livemode)
             values($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10, $11) on conflict (driver_transfer_reversal_id) do nothing`,
            [input.reversalId, source.order_id, source.debit_attempt_id, source.stripe_charge_id, source.delivery, source.fee, source.previously, reversedCents, refundCents, `service-refund:${input.reversalId}`, source.livemode]
          )
        }
      }
      return 'completed' as const
    })
  }

  public async fail(input: { reversalId: string; claimToken: string; code: string; now: Date }): Promise<void> {
    await this.pool.query(
      "update driver_transfer_reversals set status = 'failed', failure_code = $3, claim_token = null, lease_expires_at = null, next_attempt_at = null, updated_at = $4::timestamptz where id = $1::uuid and claim_token = $2::uuid and status = 'executing'",
      [input.reversalId, input.claimToken, input.code, input.now]
    )
  }

  public async retryLater(input: { reversalId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void> {
    await this.pool.query(
      "update driver_transfer_reversals set last_error_class = $3, next_attempt_at = $5::timestamptz + make_interval(secs => $4), claim_token = null, lease_expires_at = null, updated_at = now() where id = $1::uuid and claim_token = $2::uuid and status = 'executing'",
      [input.reversalId, input.claimToken, input.errorClass, input.retryAfterSeconds, input.now]
    )
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
