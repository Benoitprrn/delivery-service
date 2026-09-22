import type { Pool } from 'pg'
import { MAX_WEBHOOK_ATTEMPTS, WEBHOOK_LEASE_MINUTES } from '../ports/payment-repository.js'
import type {
  ClaimedConnectWebhookEvent,
  ConnectWebhookFailure,
  ConnectWebhookRepository,
  StoredConnectWebhookEvent
} from '../ports/connect-webhook.js'

type ClaimedRow = {
  event_id: string
  event_type: string
  stripe_account_id: string
  stripe_object_id: string
  stripe_payment_intent_id: string | null
  merchant_id: string | null
  order_id: string | null
  processing_token: string
}

export class PostgresConnectWebhookRepository implements ConnectWebhookRepository {
  constructor(private readonly pool: Pool) {}

  async record(event: StoredConnectWebhookEvent): Promise<void> {
    await this.pool.query(`
      insert into stripe_connect_webhook_events (
        event_id, event_type, stripe_account_id, stripe_object_id,
        stripe_payment_intent_id, merchant_id, order_id, status
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'pending')
      on conflict (event_id) do nothing
    `, [
      event.eventId,
      event.eventType,
      event.accountId,
      event.objectId,
      event.paymentIntentId,
      event.merchantId,
      event.orderId
    ])
  }

  async claimNext(): Promise<ClaimedConnectWebhookEvent | null> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await client.query<ClaimedRow>(`
        with candidate as (
          select event_id
          from stripe_connect_webhook_events
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
        update stripe_connect_webhook_events as events
        set
          status = 'processing',
          processing_started_at = now(),
          processing_token = gen_random_uuid()
        from candidate
        where events.event_id = candidate.event_id
        returning
          events.event_id,
          events.event_type,
          events.stripe_account_id,
          events.stripe_object_id,
          events.stripe_payment_intent_id,
          events.merchant_id,
          events.order_id,
          events.processing_token::text as processing_token
      `, [WEBHOOK_LEASE_MINUTES])
      await client.query('commit')

      const row = result.rows[0]
      if (row === undefined) return null
      return {
        token: row.processing_token,
        event: {
          eventId: row.event_id,
          eventType: row.event_type,
          accountId: row.stripe_account_id,
          objectId: row.stripe_object_id,
          paymentIntentId: row.stripe_payment_intent_id,
          merchantId: row.merchant_id,
          orderId: row.order_id
        }
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async complete(eventId: string, token: string): Promise<boolean> {
    const result = await this.pool.query(`
      update stripe_connect_webhook_events
      set
        status = 'processed',
        processed_at = now(),
        last_error = null,
        processing_token = null,
        processing_started_at = null
      where event_id = $1
        and status = 'processing'
        and processing_token = $2::uuid
    `, [eventId, token])
    return result.rowCount === 1
  }

  async fail(failure: ConnectWebhookFailure): Promise<boolean> {
    const result = await this.pool.query(`
      update stripe_connect_webhook_events
      set
        attempts = attempts + 1,
        status = case
          when $5::boolean or attempts + 1 >= $3 then 'dead_letter'
          else 'failed'
        end,
        next_attempt_at = case
          when $5::boolean or attempts + 1 >= $3 then next_attempt_at
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
    `, [failure.eventId, failure.token, MAX_WEBHOOK_ATTEMPTS, failure.errorClass, failure.terminal])
    return result.rowCount === 1
  }

  async findMerchantIdByAccountId(accountId: string): Promise<string | null> {
    const result = await this.pool.query<{ merchant_id: string }>(
      'select merchant_id from merchant_payment_profiles where stripe_account_id = $1',
      [accountId]
    )
    return result.rows[0]?.merchant_id ?? null
  }
}
