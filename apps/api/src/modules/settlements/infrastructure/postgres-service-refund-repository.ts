import type { Pool } from 'pg'
import type { ServiceRefundRepository, ServiceRefundWork } from '../ports/service-refund.js'

export class PostgresServiceRefundRepository implements ServiceRefundRepository {
  public constructor(private readonly pool: Pool) {}
  public async claimDue(input: { now: Date; limit: number; leaseSeconds: number }): Promise<ServiceRefundWork[]> {
    const candidates = await this.pool.query<{ id: string }>("select id from driver_reversal_service_refunds where status in ('pending','executing') and coalesce(next_attempt_at, '-infinity'::timestamptz) <= $1 and (claim_token is null or lease_expires_at < now()) order by created_at limit $2", [input.now, input.limit])
    const claimed = await Promise.all(candidates.rows.map(async ({ id }) => (await this.pool.query<{ id: string; claim_token: string; attempt_count: number; stripe_charge_id: string; refund_cents: string; idempotency_key: string; livemode: boolean; driver_transfer_reversal_id: string; order_id: string }>(
      `update driver_reversal_service_refunds set status = 'executing', claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $2), attempt_count = attempt_count + 1, next_attempt_at = null, updated_at = now()
       where id = $1::uuid and status in ('pending','executing') and (claim_token is null or lease_expires_at < now()) and coalesce(next_attempt_at, '-infinity'::timestamptz) <= $3
       returning id, claim_token, attempt_count, stripe_charge_id, refund_cents::text, idempotency_key, livemode, driver_transfer_reversal_id, order_id`, [id, input.leaseSeconds, input.now])).rows[0]))
    return claimed.filter((row): row is NonNullable<typeof row> => row !== undefined).map((row) => ({ id: row.id, claimToken: row.claim_token, attemptCount: row.attempt_count, stripeChargeId: row.stripe_charge_id, refundCents: Number(row.refund_cents), idempotencyKey: row.idempotency_key, livemode: row.livemode, reversalId: row.driver_transfer_reversal_id, orderId: row.order_id }))
  }
  public async complete(input: { serviceRefundId: string; claimToken: string; stripeRefundId: string; now: Date }): Promise<'completed' | 'lost_claim'> {
    const result = await this.pool.query("update driver_reversal_service_refunds set status = 'succeeded', stripe_refund_id = $3, executed_at = $4, claim_token = null, lease_expires_at = null, next_attempt_at = null, last_error_class = null, updated_at = now() where id = $1::uuid and claim_token = $2::uuid and status = 'executing'", [input.serviceRefundId, input.claimToken, input.stripeRefundId, input.now])
    return result.rowCount === 1 ? 'completed' : 'lost_claim'
  }
  public async fail(input: { serviceRefundId: string; claimToken: string; code: string; now: Date }): Promise<void> { await this.pool.query("update driver_reversal_service_refunds set status = 'failed', failure_code = $3, claim_token = null, lease_expires_at = null, next_attempt_at = null, updated_at = $4 where id = $1::uuid and claim_token = $2::uuid and status = 'executing'", [input.serviceRefundId, input.claimToken, input.code, input.now]) }
  public async retryLater(input: { serviceRefundId: string; claimToken: string; errorClass: string; retryAfterSeconds: number; now: Date }): Promise<void> { await this.pool.query("update driver_reversal_service_refunds set last_error_class = $3, next_attempt_at = $5::timestamptz + make_interval(secs => $4), claim_token = null, lease_expires_at = null, updated_at = now() where id = $1::uuid and claim_token = $2::uuid and status = 'executing'", [input.serviceRefundId, input.claimToken, input.errorClass, input.retryAfterSeconds, input.now]) }
}
