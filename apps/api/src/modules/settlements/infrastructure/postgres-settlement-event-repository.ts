import type { Pool } from 'pg'
import type { ReducedSettlementEvent } from '../domain/stripe-event-triage.js'
import type { ClaimedSettlementEvent, SettlementEventRepository } from '../ports/settlement-ops.js'

type Row = { event_id: string; event_type: string; object_id: string | null; payment_intent_id: string | null; charge_id: string | null; transfer_id: string | null; attempt_count: number; claim_token: string }

/** Journal durable des webhooks plateforme : jamais le payload, seulement l'identifiant, le type et les identifiants Stripe nécessaires à la relecture. */
export class PostgresSettlementEventRepository implements SettlementEventRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(event: ReducedSettlementEvent, now: Date): Promise<'recorded' | 'duplicate'> {
    const result = await this.pool.query(
      `insert into settlement_stripe_events(event_id, event_type, object_id, payment_intent_id, charge_id, transfer_id, received_at, next_attempt_at) values($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz) on conflict (event_id) do nothing`,
      [event.id, event.type, event.objectId, event.paymentIntentId, event.chargeId, event.transferId, now]
    )
    return result.rowCount === 1 ? 'recorded' : 'duplicate'
  }

  public async claimNext(input: { now: Date; leaseSeconds: number }): Promise<ClaimedSettlementEvent | null> {
    const result = await this.pool.query<Row>(
      `with due as (
         select event_id from settlement_stripe_events
          where (status = 'pending' and next_attempt_at <= $1::timestamptz) or (status = 'processing' and lease_expires_at < now())
          order by next_attempt_at, received_at limit 1 for update skip locked
       )
       update settlement_stripe_events e set status = 'processing', claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $2), attempt_count = e.attempt_count + 1
         from due where e.event_id = due.event_id
       returning e.event_id, e.event_type, e.object_id, e.payment_intent_id, e.charge_id, e.transfer_id, e.attempt_count, e.claim_token`,
      [input.now, input.leaseSeconds]
    )
    const row = result.rows[0]
    if (row === undefined) return null
    return { attemptCount: row.attempt_count, token: row.claim_token, event: { id: row.event_id, type: row.event_type, accountId: null, objectId: row.object_id, paymentIntentId: row.payment_intent_id, chargeId: row.charge_id, transferId: row.transfer_id } }
  }

  public async complete(eventId: string, token: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      "update settlement_stripe_events set status = 'processed', processed_at = $3::timestamptz, claim_token = null, lease_expires_at = null, last_error_class = null where event_id = $1 and claim_token = $2::uuid and status = 'processing'",
      [eventId, token, now]
    )
    return result.rowCount === 1
  }

  public async fail(input: { eventId: string; token: string; errorClass: string; retryAfterSeconds: number | null; now: Date }): Promise<boolean> {
    const result = await this.pool.query(
      `update settlement_stripe_events set status = case when $4::int is null then 'dead_letter' else 'pending' end, last_error_class = $3, claim_token = null, lease_expires_at = null,
              next_attempt_at = case when $4::int is null then next_attempt_at else $5::timestamptz + make_interval(secs => $4::int) end
        where event_id = $1 and claim_token = $2::uuid and status = 'processing'`,
      [input.eventId, input.token, input.errorClass, input.retryAfterSeconds, input.now]
    )
    return result.rowCount === 1
  }
}
