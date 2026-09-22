import type { Pool } from 'pg'
import type { DebitClassification, DebitObservation } from '../domain/sepa-debit.js'
import { buildDebitIdempotencyKey } from '../domain/sepa-debit.js'
import { parseLocalDate } from '../domain/local-date.js'
import type { CreateAttemptResult, DebitAttemptWork, DebitSource, DueSettlement, SepaDebitRepository } from '../ports/sepa-debit.js'

type WorkRow = { id: string; merchant_settlement_id: string; merchant_id: string; attempt_no: number; status: 'creating' | 'processing'; amount_cents: string; idempotency_key: string; stripe_account_id: string; stripe_payment_method_id: string; stripe_mandate_id: string | null; stripe_payment_intent_id: string | null; claim_token: string; created_at: Date }

const WORK_COLUMNS = `a.id, a.merchant_settlement_id, ms.merchant_id, a.attempt_no, a.status, a.amount_cents::text as amount_cents, a.idempotency_key, a.stripe_account_id,
  a.stripe_payment_method_id, a.stripe_mandate_id, a.stripe_payment_intent_id, a.claim_token, a.created_at`

const toWork = (row: WorkRow): DebitAttemptWork => ({
  id: row.id, merchantSettlementId: row.merchant_settlement_id, merchantId: row.merchant_id, attemptNo: row.attempt_no, status: row.status, amountCents: Number(row.amount_cents),
  idempotencyKey: row.idempotency_key, stripeAccountId: row.stripe_account_id, paymentMethodId: row.stripe_payment_method_id, mandateId: row.stripe_mandate_id,
  paymentIntentId: row.stripe_payment_intent_id, claimToken: row.claim_token, createdAt: row.created_at
})

/**
 * Exécution des prélèvements SEPA (R50). Toutes les transitions sont des UPDATE atomiques conditionnés par le jeton de bail ; le
 * statut du règlement restaurant et celui des statements livreurs changent dans la MÊME transaction que la tentative. Aucun appel réseau ici.
 */
export class PostgresSepaDebitRepository implements SepaDebitRepository {
  public constructor(private readonly pool: Pool) {}

  public async listDueSettlements(input: { now: Date; startHour: number; limit: number }): Promise<DueSettlement[]> {
    const result = await this.pool.query<{ id: string; merchant_id: string; amount_cents: string; debit_date: string; notification_id: string; mandate_reference: string; attempt_no: number }>(
      `select ms.id, ms.merchant_id, ms.amount_cents::text as amount_cents, n.debit_date::text as debit_date, n.id as notification_id, n.mandate_reference, n.attempt_no
         from merchant_settlements ms
         join settlement_pre_notifications n on n.merchant_settlement_id = ms.id and n.status = 'sent'
          and n.attempt_no = coalesce((select max(a.attempt_no) from debit_attempts a where a.merchant_settlement_id = ms.id), 0) + 1
        where ms.amount_cents > 0
          and ((n.attempt_no = 1 and ms.status = 'notified') or (n.attempt_no > 1 and ms.status in ('failed','technical_hold')))
          and not exists (select 1 from debit_attempts a where a.merchant_settlement_id = ms.id and a.status in ('creating','processing','succeeded'))
          and ((n.debit_date + make_interval(hours => $2)) at time zone 'Europe/Paris') <= $1::timestamptz
        order by n.debit_date, ms.id
        limit $3`,
      [input.now, input.startHour, input.limit]
    )
    return result.rows.map((row) => ({ merchantSettlementId: row.id, attemptNo: row.attempt_no, merchantId: row.merchant_id, amountCents: Number(row.amount_cents), debitDate: parseLocalDate(row.debit_date), preNotificationId: row.notification_id, notifiedMandateReference: row.mandate_reference }))
  }

  public async createAttempt(input: { merchantSettlementId: string; attemptNo: number; source: DebitSource; livemode: boolean; leaseSeconds: number }): Promise<CreateAttemptResult> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const locked = await client.query<{ status: string }>('select status from merchant_settlements where id = $1 for update', [input.merchantSettlementId])
      const previous = await client.query<{ last_no: number | null; live: string }>("select max(attempt_no) as last_no, count(*) filter (where status in ('creating','processing','succeeded')) as live from debit_attempts where merchant_settlement_id = $1", [input.merchantSettlementId])
      const lastNo = previous.rows[0]?.last_no ?? 0
      const status = locked.rows[0]?.status
      const statusAllowed = input.attemptNo === 1 ? status === 'notified' : status === 'failed' || status === 'technical_hold'
      if (!statusAllowed || Number(previous.rows[0]?.live ?? 0) > 0 || lastNo + 1 !== input.attemptNo) {
        await client.query('rollback')
        return { outcome: 'skipped' }
      }
      try {
        await client.query('savepoint attempt_insert')
        const inserted = await client.query<WorkRow>(
          `with a as (
             insert into debit_attempts(merchant_settlement_id, attempt_no, amount_cents, stripe_account_id, idempotency_key, status, livemode,
                                        stripe_payment_method_id, stripe_mandate_id, mandate_reference, claim_token, lease_expires_at)
             select ms.id, $9::int, ms.amount_cents, $2, $3, 'creating', $4, $5, $6, $7, gen_random_uuid(), now() + make_interval(secs => $8)
               from merchant_settlements ms where ms.id = $1
             returning *
           ) select ${WORK_COLUMNS} from a join merchant_settlements ms on ms.id = a.merchant_settlement_id`,
          [input.merchantSettlementId, input.source.stripeAccountId, buildDebitIdempotencyKey({ merchantSettlementId: input.merchantSettlementId, attemptNo: input.attemptNo }), input.livemode,
            input.source.paymentMethodId, input.source.mandateId, input.source.mandateReference, input.leaseSeconds, input.attemptNo]
        )
        await client.query("update merchant_settlements set status = 'debit_scheduled', debit_blocked_reason = null, debit_blocked_at = null, updated_at = now() where id = $1", [input.merchantSettlementId])
        await client.query("update settlement_statements set status = 'waiting_sepa', updated_at = now() where merchant_settlement_id = $1 and status in ('unpaid','unpaid_restaurant')", [input.merchantSettlementId])
        await client.query('commit')
        return { outcome: 'created', work: toWork(inserted.rows[0]!) }
      } catch (error) {
        // Refus des gardes de base (pré-notification, préavis, date annoncée, mandat) : rien n'est créé, aucun appel Stripe ne suivra.
        if ((error as { code?: string }).code === 'P0001') {
          await client.query('rollback')
          return { outcome: 'refused', reason: 'debit_guard_refused' }
        }
        throw error
      }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  public async setBlocked(merchantSettlementId: string, reason: string | null, now: Date): Promise<void> {
    await this.pool.query(
      `update merchant_settlements set debit_blocked_reason = $2::text, debit_blocked_at = case when $2::text is null then null else coalesce(debit_blocked_at, $3::timestamptz) end, updated_at = now()
        where id = $1 and status in ('notified','failed','technical_hold') and debit_blocked_reason is distinct from $2::text`,
      [merchantSettlementId, reason, now]
    )
  }

  public async claimWork(input: { now: Date; limit: number; leaseSeconds: number }): Promise<DebitAttemptWork[]> {
    const result = await this.pool.query<WorkRow>(
      `with due as (
         select id from debit_attempts
          where status in ('creating','processing') and coalesce(next_sync_at, '-infinity'::timestamptz) <= $3::timestamptz and (claim_token is null or lease_expires_at < now())
          order by created_at limit $1 for update skip locked
       ), claimed as (
         update debit_attempts a set claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
           from due where a.id = due.id returning a.*
       ) select ${WORK_COLUMNS} from claimed a join merchant_settlements ms on ms.id = a.merchant_settlement_id order by a.created_at`,
      [input.limit, input.leaseSeconds, input.now]
    )
    return result.rows.map(toWork)
  }

  public async applyObservation(input: { attemptId: string; claimToken: string; observation: DebitObservation; classification: DebitClassification; now: Date; syncDelaySeconds: number }): Promise<'applied' | 'lost_claim'> {
    const { observation, classification } = input
    return this.transition(async (client) => {
      const updated = await client.query<{ merchant_settlement_id: string }>(
        `update debit_attempts
            set status = $3, stripe_payment_intent_id = coalesce(stripe_payment_intent_id, $4), stripe_charge_id = coalesce(stripe_charge_id, $5),
                submitted_at = coalesce(submitted_at, $6::timestamptz),
                succeeded_at = case when $3 = 'succeeded' then $6::timestamptz else succeeded_at end,
                failed_at = case when $3 = 'failed' then $6::timestamptz else failed_at end,
                failure_code = case when $3 = 'failed' then $7 else failure_code end,
                available_on = coalesce($8::timestamptz, available_on),
                next_sync_at = case when $3 = 'processing' then $6::timestamptz + make_interval(secs => $9) else null end,
                last_synced_at = $6::timestamptz, sync_error_class = null, claim_token = null, lease_expires_at = null, updated_at = now()
          where id = $1 and claim_token = $2 and status in ('creating','processing')
          returning merchant_settlement_id`,
        [input.attemptId, input.claimToken, classification.state, observation.paymentIntentId, observation.chargeId, input.now, classification.failureCode, observation.availableOn, input.syncDelaySeconds]
      )
      const settlementId = updated.rows[0]?.merchant_settlement_id
      if (settlementId === undefined) return false
      await this.followOnStatuses(client, settlementId, classification.state)
      return true
    })
  }

  public async markRejected(input: { attemptId: string; claimToken: string; code: string; now: Date }): Promise<'applied' | 'lost_claim'> {
    return this.transition(async (client) => {
      const updated = await client.query<{ merchant_settlement_id: string }>(
        `update debit_attempts set status = 'failed', failed_at = $3::timestamptz, failure_code = $4, next_sync_at = null, last_synced_at = $3::timestamptz,
                claim_token = null, lease_expires_at = null, updated_at = now()
          where id = $1 and claim_token = $2 and status in ('creating','processing') returning merchant_settlement_id`,
        [input.attemptId, input.claimToken, input.now, input.code]
      )
      const settlementId = updated.rows[0]?.merchant_settlement_id
      if (settlementId === undefined) return false
      await this.followOnStatuses(client, settlementId, 'failed')
      return true
    })
  }

  public async markTechnical(input: { attemptId: string; claimToken: string; code: string; paymentIntentId: string | null; chargeId: string | null; now: Date }): Promise<'applied' | 'lost_claim'> {
    return this.transition(async (client) => {
      const updated = await client.query<{ merchant_settlement_id: string }>(
        `update debit_attempts set status = 'technical_error', technical_error_at = $3::timestamptz, failure_code = $4,
                stripe_payment_intent_id = coalesce(stripe_payment_intent_id, $5), stripe_charge_id = coalesce(stripe_charge_id, $6),
                next_sync_at = null, last_synced_at = $3::timestamptz, claim_token = null, lease_expires_at = null, updated_at = now()
          where id = $1 and claim_token = $2 and status in ('creating','processing') returning merchant_settlement_id`,
        [input.attemptId, input.claimToken, input.now, input.code, input.paymentIntentId, input.chargeId]
      )
      const settlementId = updated.rows[0]?.merchant_settlement_id
      if (settlementId === undefined) return false
      await this.followOnStatuses(client, settlementId, 'technical')
      return true
    })
  }

  public async markRetryable(input: { attemptId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void> {
    await this.pool.query(
      `update debit_attempts set sync_error_class = $3, next_sync_at = $5::timestamptz + make_interval(secs => $4), claim_token = null, lease_expires_at = null, updated_at = now()
        where id = $1 and claim_token = $2 and status in ('creating','processing')`,
      [input.attemptId, input.claimToken, input.errorClass, input.retryAfterSeconds, input.now]
    )
  }

  private async transition(body: (client: import('pg').PoolClient) => Promise<boolean>): Promise<'applied' | 'lost_claim'> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const applied = await body(client)
      await client.query(applied ? 'commit' : 'rollback')
      return applied ? 'applied' : 'lost_claim'
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async followOnStatuses(client: import('pg').PoolClient, merchantSettlementId: string, state: 'processing' | 'succeeded' | 'failed' | 'technical'): Promise<void> {
    const settlementStatus = { processing: 'debit_processing', succeeded: 'succeeded', failed: 'failed', technical: 'technical_hold' }[state]
    await client.query('update merchant_settlements set status = $2, updated_at = now() where id = $1', [merchantSettlementId, settlementStatus])
    // Erreur technique : les statements ne changent PAS d'état (le restaurant n'est pas qualifié d'impayé).
    if (state === 'technical') return
    const statementStatus = { processing: 'waiting_sepa', succeeded: 'succeeded_held', failed: 'unpaid_restaurant' }[state]
    await client.query("update settlement_statements set status = $2, updated_at = now() where merchant_settlement_id = $1 and status in ('unpaid','waiting_sepa')", [merchantSettlementId, statementStatus])
  }
}
