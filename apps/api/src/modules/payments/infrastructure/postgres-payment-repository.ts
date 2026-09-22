import type { Pool } from 'pg'
import {
  DETACH_LEASE_MINUTES,
  MAX_DETACH_ATTEMPTS,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_LEASE_MINUTES,
  type ActivePaymentMethod,
  type ClaimedStripeWebhookEvent,
  type DetachClaim,
  type DetachFailure,
  type MerchantPaymentMethod,
  type MerchantPaymentProfile,
  type PaymentRepository,
  type StoredStripeWebhookEvent,
  type WebhookFailure
} from '../ports/payment-repository.js'

type Row = Record<string, unknown>

function map(row: Row): MerchantPaymentMethod {
  return {
    id: String(row.id),
    merchantId: String(row.merchant_id),
    setupIntentId: String(row.stripe_setup_intent_id),
    stripePaymentMethodId: row.stripe_payment_method_id as string | null,
    stripeMandateId: row.stripe_mandate_id as string | null,
    status: row.status as MerchantPaymentMethod['status'],
    bankName: row.bank_name as string | null,
    last4: row.last4 as string | null,
    country: row.country as string | null,
    mandateReference: row.mandate_reference as string | null,
    activatedAt: row.activated_at as Date | null,
    invalidatedAt: row.invalidated_at as Date | null
  }
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: Pool) {}

  async findProfile(merchantId: string): Promise<MerchantPaymentProfile | null> { const r = await this.pool.query<Row>('select merchant_id, stripe_account_id from merchant_payment_profiles where merchant_id = $1', [merchantId]); return r.rows[0] === undefined ? null : { merchantId: String(r.rows[0].merchant_id), stripeAccountId: String(r.rows[0].stripe_account_id) } }
  async saveProfile(value: MerchantPaymentProfile): Promise<MerchantPaymentProfile> { const r = await this.pool.query<Row>('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values($1, $2) on conflict(merchant_id) do update set stripe_account_id = merchant_payment_profiles.stripe_account_id, updated_at = now() returning merchant_id, stripe_account_id', [value.merchantId, value.stripeAccountId]); return { merchantId: String(r.rows[0]!.merchant_id), stripeAccountId: String(r.rows[0]!.stripe_account_id) } }
  async findActive(merchantId: string): Promise<ActivePaymentMethod | null> { const r = await this.pool.query<Row>("select * from merchant_payment_methods where merchant_id = $1 and status = 'active'", [merchantId]); return r.rows[0] === undefined ? null : map(r.rows[0]) as ActivePaymentMethod }

  async findDisplayMethod(merchantId: string): Promise<MerchantPaymentMethod | null> {
    const result = await this.pool.query<Row>(`
      select *
      from merchant_payment_methods
      where merchant_id = $1
        and (
          status = 'active'
          or (status = 'invalid' and stripe_payment_method_id is not null)
        )
      order by (status = 'active') desc, updated_at desc, id desc
      limit 1
    `, [merchantId])
    return result.rows[0] === undefined ? null : map(result.rows[0])
  }

  async findPending(merchantId: string): Promise<MerchantPaymentMethod | null> { const r = await this.pool.query<Row>("select * from merchant_payment_methods where merchant_id = $1 and status = 'setup_pending' order by created_at desc limit 1", [merchantId]); return r.rows[0] === undefined ? null : map(r.rows[0]) }
  async findBySetupIntent(id: string): Promise<MerchantPaymentMethod | null> { const r = await this.pool.query<Row>('select * from merchant_payment_methods where stripe_setup_intent_id = $1', [id]); return r.rows[0] === undefined ? null : map(r.rows[0]) }
  async createPending(merchantId: string, setupIntentId: string): Promise<MerchantPaymentMethod> { const c = await this.pool.connect(); try { await c.query('begin'); await c.query("update merchant_payment_methods set status = 'invalid', invalidated_at = now(), updated_at = now() where merchant_id = $1 and status = 'setup_pending' and stripe_setup_intent_id <> $2", [merchantId, setupIntentId]); const r = await c.query<Row>("insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, status) values($1, $2, 'setup_pending') on conflict(stripe_setup_intent_id) do update set updated_at = now() returning *", [merchantId, setupIntentId]); await c.query('commit'); return map(r.rows[0]!) } catch (e) { await c.query('rollback'); throw e } finally { c.release() } }
  async invalidatePending(id: string): Promise<void> { await this.pool.query("update merchant_payment_methods set status = 'invalid', invalidated_at = now(), updated_at = now() where stripe_setup_intent_id = $1 and status = 'setup_pending'", [id]) }
  async activate(setupIntentId: string, details: Omit<MerchantPaymentMethod, 'id' | 'merchantId' | 'setupIntentId' | 'status' | 'activatedAt' | 'invalidatedAt'>): Promise<{ active: ActivePaymentMethod; previous: ActivePaymentMethod | null }> { const c = await this.pool.connect(); try { await c.query('begin'); const pending = await c.query<Row>("select * from merchant_payment_methods where stripe_setup_intent_id = $1 and status = 'setup_pending' for update", [setupIntentId]); if (pending.rows[0] === undefined) { const existing = await c.query<Row>("select * from merchant_payment_methods where stripe_setup_intent_id = $1 and status = 'active'", [setupIntentId]); if (existing.rows[0] === undefined) throw new Error('Payment setup is not pending'); await c.query('commit'); return { active: map(existing.rows[0]) as ActivePaymentMethod, previous: null } } const previous = await c.query<Row>("select * from merchant_payment_methods where merchant_id = $1 and status = 'active' for update", [pending.rows[0].merchant_id]); await c.query("update merchant_payment_methods set status = 'detach_pending', updated_at = now() where merchant_id = $1 and status = 'active'", [pending.rows[0].merchant_id]); const next = await c.query<Row>("update merchant_payment_methods set stripe_payment_method_id = $2, stripe_mandate_id = $3, bank_name = $4, last4 = $5, country = $6, mandate_reference = $7, status = 'active', activated_at = now(), invalidated_at = null, updated_at = now() where stripe_setup_intent_id = $1 returning *", [setupIntentId, details.stripePaymentMethodId, details.stripeMandateId, details.bankName, details.last4, details.country, details.mandateReference]); await c.query('commit'); return { active: map(next.rows[0]!) as ActivePaymentMethod, previous: previous.rows[0] === undefined ? null : map(previous.rows[0]) as ActivePaymentMethod } } catch (e) { await c.query('rollback'); throw e } finally { c.release() } }

  async markDetached(paymentMethodId: string): Promise<void> {
    await this.pool.query(`
      update merchant_payment_methods
      set
        status = case when status = 'detach_pending' then 'detached' else 'invalid' end,
        detached_at = case when status = 'detach_pending' then now() else detached_at end,
        invalidated_at = case when status = 'active' then now() else invalidated_at end,
        detach_locked_until = null,
        detach_processing_token = null,
        updated_at = now()
      where stripe_payment_method_id = $1
        and status in ('detach_pending', 'active')
    `, [paymentMethodId])
  }

  async markMandateInactive(id: string): Promise<void> { await this.pool.query("update merchant_payment_methods set status = 'invalid', invalidated_at = now(), updated_at = now() where stripe_mandate_id = $1 and status = 'active'", [id]) }

  async claimDetachPending(limit: number): Promise<DetachClaim[]> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await client.query<{ payment_method_id: string; token: string }>(`
        with candidate as (
          select id
          from merchant_payment_methods
          where status = 'detach_pending'
            and stripe_payment_method_id is not null
            and detach_attempts < $1
            and (detach_next_attempt_at is null or detach_next_attempt_at <= now())
            and (detach_locked_until is null or detach_locked_until < now())
          order by updated_at, id
          for update skip locked
          limit $2
        )
        update merchant_payment_methods as methods
        set
          detach_locked_until = now() + ($3 * interval '1 minute'),
          detach_processing_token = gen_random_uuid()
        from candidate
        where methods.id = candidate.id
        returning methods.stripe_payment_method_id as payment_method_id,
          methods.detach_processing_token::text as token
      `, [MAX_DETACH_ATTEMPTS, limit, DETACH_LEASE_MINUTES])
      await client.query('commit')
      return result.rows.map(row => ({ paymentMethodId: row.payment_method_id, token: row.token }))
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async recordDetachFailure(failure: DetachFailure): Promise<boolean> {
    const result = await this.pool.query(`
      update merchant_payment_methods
      set
        detach_attempts = detach_attempts + 1,
        detach_next_attempt_at = case
          when detach_attempts + 1 >= $3 then null
          else now() + least(
            interval '6 hours',
            interval '1 minute' * power(2, detach_attempts)
          )
        end,
        detach_locked_until = null,
        detach_processing_token = null,
        updated_at = now()
      where stripe_payment_method_id = $1
        and status = 'detach_pending'
        and detach_processing_token = $2::uuid
    `, [failure.paymentMethodId, failure.token, MAX_DETACH_ATTEMPTS])
    return result.rowCount === 1
  }

  async recordWebhookEvent(event: StoredStripeWebhookEvent): Promise<void> { await this.pool.query("insert into stripe_webhook_events(event_id, event_type, stripe_object_id, merchant_id, object_status, status) values($1, $2, $3, $4, $5, 'pending') on conflict(event_id) do nothing", [event.eventId, event.eventType, event.objectId, event.merchantId, event.objectStatus]) }

  async claimNextWebhookEvent(): Promise<ClaimedStripeWebhookEvent | null> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await client.query<{ event_id: string; event_type: string; stripe_object_id: string; merchant_id: string | null; object_status: string | null; processing_token: string }>(`
        with candidate as (
          select event_id
          from stripe_webhook_events
          where (
            status in ('pending', 'failed')
            and next_attempt_at <= now()
          ) or (
            status = 'processing'
            and processing_started_at < now() - ($1 * interval '1 minute')
          )
          order by next_attempt_at, received_at, event_id
          for update skip locked
          limit 1
        )
        update stripe_webhook_events as events
        set
          status = 'processing',
          processing_started_at = now(),
          processing_token = gen_random_uuid()
        from candidate
        where events.event_id = candidate.event_id
        returning events.event_id, events.event_type, events.stripe_object_id,
          events.merchant_id, events.object_status,
          events.processing_token::text as processing_token
      `, [WEBHOOK_LEASE_MINUTES])
      await client.query('commit')
      const row = result.rows[0]
      return row === undefined ? null : {
        event: { eventId: row.event_id, eventType: row.event_type, objectId: row.stripe_object_id, merchantId: row.merchant_id, objectStatus: row.object_status },
        token: row.processing_token
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async completeWebhookEvent(eventId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(`
      update stripe_webhook_events
      set
        status = 'processed',
        processed_at = now(),
        last_error = null,
        processing_token = null
      where event_id = $1
        and status = 'processing'
        and processing_token = $2::uuid
    `, [eventId, token])
    return result.rowCount === 1
  }

  async failWebhookEvent(failure: WebhookFailure): Promise<boolean> {
    const result = await this.pool.query(`
      update stripe_webhook_events
      set
        attempts = attempts + 1,
        status = case when attempts + 1 >= $3 then 'dead_letter' else 'failed' end,
        next_attempt_at = case
          when attempts + 1 >= $3 then next_attempt_at
          else now() + least(
            interval '6 hours',
            interval '1 minute' * power(2, attempts)
          )
        end,
        last_error = $4,
        processing_token = null,
        processing_started_at = null
      where event_id = $1
        and status = 'processing'
        and processing_token = $2::uuid
    `, [failure.eventId, failure.token, MAX_WEBHOOK_ATTEMPTS, failure.errorClass])
    return result.rowCount === 1
  }
}
