import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { createStripeConnectWebhookModule } from '../../src/modules/payments/connect-webhooks.js'
import {
  ConnectAccountMismatchError,
  ProcessConnectWebhooksUseCase,
  UnknownConnectAccountError,
  UnknownConnectPaymentIntentError
} from '../../src/modules/payments/application/connect-webhook.js'
import { PostgresConnectWebhookRepository } from '../../src/modules/payments/infrastructure/postgres-connect-webhook-repository.js'
import { PostgresPaymentRepository } from '../../src/modules/payments/infrastructure/postgres-payment-repository.js'
import type { ConnectWebhookDomainPorts, StoredConnectWebhookEvent } from '../../src/modules/payments/ports/connect-webhook.js'
import { MAX_WEBHOOK_ATTEMPTS } from '../../src/modules/payments/ports/payment-repository.js'
import type { PaymentsLogger } from '../../src/modules/payments/ports/payments-logger.js'
import { CardPaymentsUseCases } from '../../src/modules/cash-on-delivery/application/card-payments.js'
import {
  PostgresCashOnDeliveryPaymentRepository,
  PostgresCompletionSessionRepository,
  PostgresMerchantConnectRepository
} from '../../src/modules/cash-on-delivery/infrastructure/postgres-cash-on-delivery-repositories.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'
import { CONNECT_SECRET, THIN_SECRET, paymentIntentEvent, sign, snapshotEvent, thinEvent } from '../support/stripe-connect-webhook.js'

const repository = new PostgresConnectWebhookRepository(pool)
const seedMerchantId = '22222222-2222-2222-2222-222222222222'
const seedDriverId = '33333333-3333-3333-3333-333333333333'
const seedZoneId = '11111111-1111-1111-1111-111111111111'
const merchantIds: string[] = []
const orderIds: string[] = []

type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; object: Record<string, unknown>; message: string }

class RecordingLogger implements PaymentsLogger {
  readonly entries: LogEntry[] = []
  debug(object: Record<string, unknown>, message: string): void { this.entries.push({ level: 'debug', object, message }) }
  info(object: Record<string, unknown>, message: string): void { this.entries.push({ level: 'info', object, message }) }
  warn(object: Record<string, unknown>, message: string): void { this.entries.push({ level: 'warn', object, message }) }
  error(object: Record<string, unknown>, message: string): void { this.entries.push({ level: 'error', object, message }) }
  at(level: LogEntry['level']): LogEntry[] { return this.entries.filter((entry) => entry.level === level) }
}

class FakeDomain implements ConnectWebhookDomainPorts {
  readonly paymentAccounts = new Map<string, string>()
  readonly reconciled: string[] = []
  readonly refreshed: Array<{ merchantId: string; accountId: string }> = []
  readonly driverAccounts = new Map<string, string>()
  readonly refreshedDrivers: Array<{ driverId: string; accountId: string }> = []
  lookups = 0
  reconcileError: Error | null = null

  async findPaymentAccountId(paymentIntentId: string): Promise<string | null> {
    this.lookups += 1
    return this.paymentAccounts.get(paymentIntentId) ?? null
  }
  async reconcilePaymentIntent(paymentIntentId: string): Promise<unknown> {
    if (this.reconcileError !== null) throw this.reconcileError
    this.reconciled.push(paymentIntentId)
    return undefined
  }
  async refreshMerchantAccountStatus(merchantId: string, accountId: string): Promise<void> {
    this.refreshed.push({ merchantId, accountId })
  }
  async refreshDriverAccountStatus(driverId: string, accountId: string): Promise<void> {
    this.refreshedDrivers.push({ driverId, accountId })
  }
  async findDriverIdByAccountId(accountId: string): Promise<string | null> {
    return this.driverAccounts.get(accountId) ?? null
  }
}

function eventId(): string { return `evt_t26_${randomUUID()}` }

function stored(overrides: Partial<StoredConnectWebhookEvent> = {}): StoredConnectWebhookEvent {
  return {
    eventId: eventId(),
    eventType: 'payment_intent.succeeded',
    accountId: 'acct_t26_a',
    objectId: 'pi_t26_1',
    paymentIntentId: 'pi_t26_1',
    merchantId: null,
    orderId: null,
    ...overrides
  }
}

type JournalRow = {
  status: string
  attempts: number
  last_error: string | null
  processing_token: string | null
  seconds_until_next: number
}

async function journal(id: string): Promise<JournalRow> {
  const result = await pool.query<JournalRow>(`
    select status, attempts, last_error, processing_token::text as processing_token,
      extract(epoch from (next_attempt_at - now()))::float as seconds_until_next
    from stripe_connect_webhook_events where event_id = $1
  `, [id])
  const row = result.rows[0]
  if (row === undefined) throw new Error(`Journal row not found: ${id}`)
  return row
}

async function makeDue(id: string): Promise<void> {
  await pool.query("update stripe_connect_webhook_events set next_attempt_at = now() - interval '1 second' where event_id = $1", [id])
}

async function merchantWithAccount(accountId: string): Promise<string> {
  const id = randomUUID()
  merchantIds.push(id)
  await pool.query('insert into merchants(id, name) values ($1, $2)', [id, `Merchant t26 ${id}`])
  await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values ($1, $2)', [id, accountId])
  return id
}

beforeAll(async () => {
  const foreign = await pool.query<{ event_id: string }>(`
    select event_id from stripe_connect_webhook_events
    where event_id not like 'evt_t26_%' and status in ('pending', 'failed', 'processing') limit 1
  `)
  if (foreign.rows[0] !== undefined) {
    throw new Error(`Non-test Connect webhook event present (${foreign.rows[0].event_id}): run with a dedicated DATABASE_URL`)
  }
})

afterEach(async () => {
  await pool.query("delete from stripe_connect_webhook_events where event_id like 'evt_t26_%'")
  await deleteTestOrders(pool, orderIds.splice(0))
  if (merchantIds.length > 0) await pool.query('delete from merchants where id = any($1::uuid[])', [merchantIds.splice(0)])
})

describe('stripe_connect_webhook_events journal', () => {
  it('has no column able to hold a payload', async () => {
    const result = await pool.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'stripe_connect_webhook_events'
      order by column_name
    `)
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'attempts', 'event_id', 'event_type', 'last_error', 'merchant_id', 'next_attempt_at', 'order_id',
      'processed_at', 'processing_started_at', 'processing_token', 'received_at', 'status',
      'stripe_account_id', 'stripe_object_id', 'stripe_payment_intent_id'
    ])
  })

  it('deduplicates on the event id and never resets a terminal state on redelivery', async () => {
    const event = stored()
    await repository.record(event)
    await repository.record(event)
    expect((await pool.query('select 1 from stripe_connect_webhook_events where event_id = $1', [event.eventId])).rowCount).toBe(1)

    const claim = await repository.claimNext()
    expect(claim?.event.eventId).toBe(event.eventId)
    await repository.complete(event.eventId, claim!.token)
    await repository.record(event)
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed', attempts: 0 })
  })

  it('rejects an invalid status and a negative attempt count at the database level', async () => {
    const event = stored()
    await repository.record(event)
    await expect(pool.query("update stripe_connect_webhook_events set status = 'done' where event_id = $1", [event.eventId])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('update stripe_connect_webhook_events set attempts = -1 where event_id = $1', [event.eventId])).rejects.toMatchObject({ code: '23514' })
  })

  it('lets exactly one of several concurrent workers claim an event', async () => {
    await repository.record(stored())
    const claims = await Promise.all(Array.from({ length: 6 }, () => repository.claimNext()))
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
  })

  it('claims events oldest-due first and never one that is not due yet', async () => {
    const later = stored()
    const sooner = stored()
    await repository.record(later)
    await repository.record(sooner)
    await pool.query("update stripe_connect_webhook_events set next_attempt_at = now() + interval '1 hour' where event_id = $1", [later.eventId])
    expect((await repository.claimNext())?.event.eventId).toBe(sooner.eventId)
    expect(await repository.claimNext()).toBeNull()
  })

  it('reclaims an expired lease with a fresh token and refuses the stale worker', async () => {
    const event = stored()
    await repository.record(event)
    const first = await repository.claimNext()
    expect(first).not.toBeNull()
    expect(await repository.claimNext()).toBeNull() // bail encore valide

    await pool.query("update stripe_connect_webhook_events set processing_started_at = now() - interval '6 minutes' where event_id = $1", [event.eventId])
    const second = await repository.claimNext()
    expect(second?.event.eventId).toBe(event.eventId)
    expect(second?.token).not.toBe(first!.token)

    expect(await repository.complete(event.eventId, first!.token)).toBe(false)
    expect(await repository.fail({ eventId: event.eventId, token: first!.token, errorClass: 'Stale', terminal: false })).toBe(false)
    expect(await journal(event.eventId)).toMatchObject({ status: 'processing', attempts: 0 })
    expect(await repository.complete(event.eventId, second!.token)).toBe(true)
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed', processing_token: null })
  })

  it('refuses to complete or fail with a wrong token', async () => {
    const event = stored()
    await repository.record(event)
    await repository.claimNext()
    expect(await repository.complete(event.eventId, randomUUID())).toBe(false)
    expect(await repository.fail({ eventId: event.eventId, token: randomUUID(), errorClass: 'X', terminal: false })).toBe(false)
    expect((await journal(event.eventId)).status).toBe('processing')
  })

  it('applies an exponential backoff (1 min, 2 min, ...) capped at 6 hours and keeps only the error class', async () => {
    const event = stored()
    await repository.record(event)

    const first = await repository.claimNext()
    expect(await repository.fail({ eventId: event.eventId, token: first!.token, errorClass: 'ReconcileError', terminal: false })).toBe(true)
    const afterFirst = await journal(event.eventId)
    expect(afterFirst).toMatchObject({ status: 'failed', attempts: 1, last_error: 'ReconcileError', processing_token: null })
    expect(afterFirst.seconds_until_next).toBeGreaterThan(50)
    expect(afterFirst.seconds_until_next).toBeLessThanOrEqual(60)
    expect(await repository.claimNext()).toBeNull() // pas encore dû

    await makeDue(event.eventId)
    const second = await repository.claimNext()
    await repository.fail({ eventId: event.eventId, token: second!.token, errorClass: 'ReconcileError', terminal: false })
    const afterSecond = await journal(event.eventId)
    expect(afterSecond.attempts).toBe(2)
    expect(afterSecond.seconds_until_next).toBeGreaterThan(110)
    expect(afterSecond.seconds_until_next).toBeLessThanOrEqual(120)

    await pool.query('update stripe_connect_webhook_events set attempts = 15 where event_id = $1', [event.eventId])
    await makeDue(event.eventId)
    const capped = await repository.claimNext()
    await repository.fail({ eventId: event.eventId, token: capped!.token, errorClass: 'ReconcileError', terminal: false })
    const afterCap = await journal(event.eventId)
    expect(afterCap.seconds_until_next).toBeGreaterThan(6 * 3600 - 10)
    expect(afterCap.seconds_until_next).toBeLessThanOrEqual(6 * 3600)
  })

  it('moves an event to dead_letter on the last allowed attempt and never claims it again', async () => {
    const event = stored()
    await repository.record(event)
    await pool.query('update stripe_connect_webhook_events set attempts = $2 where event_id = $1', [event.eventId, MAX_WEBHOOK_ATTEMPTS - 2])

    const beforeLast = await repository.claimNext()
    await repository.fail({ eventId: event.eventId, token: beforeLast!.token, errorClass: 'E', terminal: false })
    expect(await journal(event.eventId)).toMatchObject({ status: 'failed', attempts: MAX_WEBHOOK_ATTEMPTS - 1 })

    await makeDue(event.eventId)
    const last = await repository.claimNext()
    await repository.fail({ eventId: event.eventId, token: last!.token, errorClass: 'E', terminal: false })
    expect(await journal(event.eventId)).toMatchObject({ status: 'dead_letter', attempts: MAX_WEBHOOK_ATTEMPTS })

    await makeDue(event.eventId)
    expect(await repository.claimNext()).toBeNull()
  })

  it('dead-letters a terminal failure immediately', async () => {
    const event = stored()
    await repository.record(event)
    const claim = await repository.claimNext()
    await repository.fail({ eventId: event.eventId, token: claim!.token, errorClass: 'ConnectAccountMismatchError', terminal: true })
    expect(await journal(event.eventId)).toMatchObject({ status: 'dead_letter', attempts: 1, last_error: 'ConnectAccountMismatchError' })
    await makeDue(event.eventId)
    expect(await repository.claimNext()).toBeNull()
  })

  it('resolves a merchant only from a stored Stripe Account id', async () => {
    const merchantId = await merchantWithAccount('acct_t26_profile')
    expect(await repository.findMerchantIdByAccountId('acct_t26_profile')).toBe(merchantId)
    expect(await repository.findMerchantIdByAccountId('acct_t26_unknown')).toBeNull()
  })
})

describe('Connect webhook worker', () => {
  let domain: FakeDomain
  let logger: RecordingLogger
  let worker: ProcessConnectWebhooksUseCase

  beforeEach(() => {
    domain = new FakeDomain()
    logger = new RecordingLogger()
    worker = new ProcessConnectWebhooksUseCase(repository, domain, logger)
  })

  it.each([
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.canceled',
    'payment_intent.amount_capturable_updated'
  ])('triggers the reconciliation of the PaymentIntent for %s, then marks the event processed', async (eventType) => {
    domain.paymentAccounts.set('pi_t26_1', 'acct_t26_a')
    const event = stored({ eventType })
    await repository.record(event)

    expect(await worker.processBatch()).toBe(1)

    expect(domain.reconciled).toEqual(['pi_t26_1'])
    expect(domain.refreshed).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed', attempts: 0, processing_token: null })
  })

  it('never reconciles nor acts when the event account differs from the local payment account, and rejects it for good', async () => {
    domain.paymentAccounts.set('pi_t26_1', 'acct_t26_victim')
    const event = stored({ accountId: 'acct_t26_attacker' })
    await repository.record(event)

    expect(await worker.processBatch()).toBe(1)

    expect(domain.reconciled).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'dead_letter', attempts: 1, last_error: ConnectAccountMismatchError.name })
    const security = logger.at('error').filter((entry) => entry.object.security === true)
    expect(security).toHaveLength(1)
    expect(security[0]!.object).toMatchObject({
      eventId: event.eventId,
      paymentIntentId: 'pi_t26_1',
      eventAccountId: 'acct_t26_attacker',
      localAccountId: 'acct_t26_victim'
    })

    await makeDue(event.eventId)
    expect(await worker.processBatch()).toBe(0) // jamais rejoué
    expect(domain.reconciled).toEqual([])
  })

  it('fails and retries an unknown PaymentIntent (the local payment may not be committed yet), then succeeds once it exists', async () => {
    const event = stored()
    await repository.record(event)

    await worker.processBatch()
    expect(domain.reconciled).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'failed', attempts: 1, last_error: UnknownConnectPaymentIntentError.name })

    domain.paymentAccounts.set('pi_t26_1', 'acct_t26_a')
    await makeDue(event.eventId)
    await worker.processBatch()
    expect(domain.reconciled).toEqual(['pi_t26_1'])
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed', attempts: 1 })
  })

  it('dead-letters an unknown PaymentIntent after the maximum number of attempts', async () => {
    const event = stored()
    await repository.record(event)
    await pool.query('update stripe_connect_webhook_events set attempts = $2 where event_id = $1', [event.eventId, MAX_WEBHOOK_ATTEMPTS - 1])

    await worker.processBatch()

    expect(await journal(event.eventId)).toMatchObject({ status: 'dead_letter', attempts: MAX_WEBHOOK_ATTEMPTS, last_error: UnknownConnectPaymentIntentError.name })
    await makeDue(event.eventId)
    expect(await worker.processBatch()).toBe(0)
  })

  it('keeps the event retryable when the reconciliation itself fails, and never marks it processed', async () => {
    domain.paymentAccounts.set('pi_t26_1', 'acct_t26_a')
    domain.reconcileError = new Error('stripe unreachable: internal detail')
    const event = stored()
    await repository.record(event)

    await worker.processBatch()

    const row = await journal(event.eventId)
    expect(row).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Error' })
    expect(row.last_error).not.toContain('internal detail')
    expect(logger.at('error')[0]!.object).toMatchObject({ eventId: event.eventId, errorClass: 'Error' })

    domain.reconcileError = null
    await makeDue(event.eventId)
    await worker.processBatch()
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed', attempts: 1 })
  })

  it('records a refund or dispute as processed with a structured warning and no automatic action', async () => {
    const refund = stored({ eventType: 'charge.refunded', objectId: 'ch_t26_1', paymentIntentId: 'pi_t26_1', merchantId: seedMerchantId })
    const dispute = stored({ eventType: 'charge.dispute.created', objectId: 'dp_t26_1', paymentIntentId: 'pi_t26_1' })
    await repository.record(refund)
    await repository.record(dispute)

    expect(await worker.processBatch()).toBe(2)

    expect(domain.reconciled).toEqual([])
    expect(domain.refreshed).toEqual([])
    expect(domain.lookups).toBe(0)
    expect(await journal(refund.eventId)).toMatchObject({ status: 'processed', attempts: 0 })
    expect(await journal(dispute.eventId)).toMatchObject({ status: 'processed', attempts: 0 })
    const warnings = logger.at('warn')
    expect(warnings).toHaveLength(2)
    expect(warnings.map((entry) => entry.object.eventType).sort()).toEqual(['charge.dispute.created', 'charge.refunded'])
    expect(warnings[0]!.object).toMatchObject({ policy: 'D7_undecided_no_automatic_action', accountId: 'acct_t26_a', paymentIntentId: 'pi_t26_1' })
  })

  it('refreshes the merchant Connect status for a thin account event through the account owner', async () => {
    const merchantId = await merchantWithAccount('acct_t26_thin')
    const event = stored({
      eventType: 'v2.core.account[configuration.merchant].capability_status_updated',
      accountId: 'acct_t26_thin',
      objectId: 'acct_t26_thin',
      paymentIntentId: null
    })
    await repository.record(event)

    await worker.processBatch()

    expect(domain.refreshed).toEqual([{ merchantId, accountId: 'acct_t26_thin' }])
    expect(domain.reconciled).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed' })
  })

  it('refreshes a DRIVER payout account for a recipient thin event, never as a merchant, and only through the domain re-read (R30)', async () => {
    domain.driverAccounts.set('acct_t30_driver', 'driver-uuid-1')
    const event = stored({
      eventType: 'v2.core.account[configuration.recipient].capability_status_updated',
      accountId: 'acct_t30_driver',
      objectId: 'acct_t30_driver',
      paymentIntentId: null
    })
    await repository.record(event)

    await worker.processBatch()

    expect(domain.refreshedDrivers).toEqual([{ driverId: 'driver-uuid-1', accountId: 'acct_t30_driver' }])
    expect(domain.refreshed).toEqual([])
    expect(domain.reconciled).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'processed' })
  })

  it('fails and retries a thin event for an account that no local merchant owns', async () => {
    const event = stored({ eventType: 'v2.core.account[requirements].updated', accountId: 'acct_t26_nobody', objectId: 'acct_t26_nobody', paymentIntentId: null })
    await repository.record(event)

    await worker.processBatch()

    expect(domain.refreshed).toEqual([])
    expect(await journal(event.eventId)).toMatchObject({ status: 'failed', last_error: UnknownConnectAccountError.name })
  })

  it('isolates failures: one failing event does not block the next one in the same batch', async () => {
    domain.paymentAccounts.set('pi_t26_ok', 'acct_t26_a')
    const failing = stored({ objectId: 'pi_t26_unknown', paymentIntentId: 'pi_t26_unknown' })
    const healthy = stored({ objectId: 'pi_t26_ok', paymentIntentId: 'pi_t26_ok' })
    await repository.record(failing)
    await repository.record(healthy)
    await pool.query("update stripe_connect_webhook_events set received_at = now() - interval '1 minute' where event_id = $1", [failing.eventId])

    expect(await worker.processBatch()).toBe(2)

    expect((await journal(failing.eventId)).status).toBe('failed')
    expect((await journal(healthy.eventId)).status).toBe('processed')
    expect(domain.reconciled).toEqual(['pi_t26_ok'])
  })
})

describe('Connect webhook end to end (signature to worker), without Stripe network', () => {
  const secretKey = 'sk_test_local_only'

  function moduleWith(domain: ConnectWebhookDomainPorts, logger = new RecordingLogger()) {
    return createStripeConnectWebhookModule(pool, {
      paymentsEnabled: true,
      secretKey,
      webhookSecret: `${CONNECT_SECRET},${THIN_SECRET}`,
      domain
    }, logger)
  }

  it('persists a verified event without its payload, deduplicates redelivery, then triggers reconciliation only', async () => {
    const domain = new FakeDomain()
    domain.paymentAccounts.set('pi_t26_e2e', 'acct_t26_e2e')
    const module = moduleWith(domain)
    const id = eventId()
    const payload = paymentIntentEvent(id, 'payment_intent.succeeded', 'pi_t26_e2e', 'acct_t26_e2e', { merchant_id: seedMerchantId, secret_note: 'do-not-store' })

    await module.receiveWebhook(payload, sign(payload))
    await module.receiveWebhook(payload, sign(payload))

    const rows = await pool.query('select * from stripe_connect_webhook_events where event_id = $1', [id])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({
      event_type: 'payment_intent.succeeded',
      stripe_account_id: 'acct_t26_e2e',
      stripe_object_id: 'pi_t26_e2e',
      stripe_payment_intent_id: 'pi_t26_e2e',
      merchant_id: seedMerchantId,
      status: 'pending'
    })
    expect(JSON.stringify(rows.rows[0])).not.toContain('do-not-store')

    expect(await module.processBatch()).toBe(1)
    expect(domain.reconciled).toEqual(['pi_t26_e2e'])
    expect((await journal(id)).status).toBe('processed')
  })

  it('does not persist anything for an invalid signature or an unsupported event type', async () => {
    const module = moduleWith(new FakeDomain())
    const supported = paymentIntentEvent(eventId(), 'payment_intent.succeeded', 'pi_t26_1')
    await expect(module.receiveWebhook(supported, sign(supported, 'whsec_wrong'))).rejects.toThrow('Invalid Stripe Connect webhook signature')
    const unsupported = snapshotEvent({ id: eventId(), type: 'charge.succeeded', object: { id: 'ch_1' } })
    await module.receiveWebhook(unsupported, sign(unsupported))
    expect((await pool.query("select 1 from stripe_connect_webhook_events where event_id like 'evt_t26_%'")).rowCount).toBe(0)
  })

  it('never completes the order or the payment by itself: a succeeded event changes nothing without the reconciliation', async () => {
    const sessions = new PostgresCompletionSessionRepository(pool)
    const codPayments = new PostgresCashOnDeliveryPaymentRepository(pool)
    const orderId = randomUUID()
    await pool.query(`insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,cash_on_delivery_required,cash_on_delivery_amount_cents,cash_on_delivery_currency,cash_on_delivery_created_at) values($1,$2,$3,$4,'COLLECTED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.23,0,0,400,true,5000,'eur',now())`, [orderId, seedMerchantId, seedDriverId, seedZoneId])
    orderIds.push(orderId)
    const session = await sessions.createOrResume({ orderId, driverId: seedDriverId, expectedOrderVersion: 1, expiresAt: new Date(Date.now() + 3_600_000) })
    const paymentId = randomUUID()
    const created = await codPayments.createAttempt({
      id: paymentId, orderId, sessionId: session.id, merchantId: seedMerchantId, driverId: seedDriverId,
      stripeAccountId: 'acct_t26_cod', amountCents: 5000, currency: 'eur', status: 'created',
      captureIdempotencyKey: `capture-${paymentId}`, createIdempotencyKey: `create-${paymentId}`,
      readerType: 'bluetooth', readerSerial: null, terminalLocationId: 'tml_t26'
    })
    await codPayments.transition({ id: created.id, from: ['created'], to: 'authorized', stripePaymentIntentId: 'pi_t26_cod' })

    const reconciled: string[] = []
    const module = moduleWith({
      findPaymentAccountId: async (paymentIntentId) => (await codPayments.findByPaymentIntentId(paymentIntentId))?.stripeAccountId ?? null,
      reconcilePaymentIntent: async (paymentIntentId) => { reconciled.push(paymentIntentId) },
      refreshMerchantAccountStatus: async () => undefined,
      refreshDriverAccountStatus: async () => undefined,
      findDriverIdByAccountId: async () => null
    })
    const id = eventId()
    const payload = paymentIntentEvent(id, 'payment_intent.succeeded', 'pi_t26_cod', 'acct_t26_cod')

    await module.receiveWebhook(payload, sign(payload))
    await module.processBatch()

    expect(reconciled).toEqual(['pi_t26_cod'])
    const order = await pool.query<{ status: string; cash_on_delivery_collected_at: Date | null }>('select status, cash_on_delivery_collected_at from orders where id = $1', [orderId])
    expect(order.rows[0]).toEqual({ status: 'COLLECTED', cash_on_delivery_collected_at: null })
    expect((await codPayments.findByOrderId(orderId))?.status).toBe('authorized')
    expect((await sessions.findByOrderId(orderId))?.status).toBe('open')
    expect((await journal(id)).status).toBe('processed')
  })

  it('refreshes merchant_stripe_connect from a thin capability event, re-reading the account through the COD provider', async () => {
    const merchantId = await merchantWithAccount('acct_t26_chain')
    const provider = new FakeConnectPaymentsProvider()
    provider.accountStatus = { ...provider.accountStatus, cardPayments: 'active', cartesBancaires: 'pending', requirementsCount: 0 }
    const payments = new PostgresPaymentRepository(pool)
    const connects = new PostgresMerchantConnectRepository(pool)
    const cardPayments = new CardPaymentsUseCases(
      {
        getMerchantStripeAccountId: async (id) => (await payments.findProfile(id))?.stripeAccountId ?? null,
        ensureMerchantStripeAccount: async () => { throw new Error('not used') }
      },
      provider,
      connects,
      { returnUrl: 'https://example.test/return', refreshUrl: 'https://example.test/refresh' }
    )
    const module = moduleWith({
      findPaymentAccountId: async () => null,
      reconcilePaymentIntent: async () => undefined,
      refreshMerchantAccountStatus: async (id) => { await cardPayments.getStatus(id) },
      refreshDriverAccountStatus: async () => undefined,
      findDriverIdByAccountId: async () => null
    })
    const id = eventId()
    const payload = thinEvent(id, 'v2.core.account[configuration.merchant].capability_status_updated', 'acct_t26_chain')
    expect(await connects.findByMerchantId(merchantId)).toBeNull()

    await module.receiveWebhook(payload, sign(payload, THIN_SECRET))
    await module.processBatch()

    expect(provider.calls.getAccountStatus).toBe(1)
    expect(await connects.findByMerchantId(merchantId)).toMatchObject({ cardPaymentsStatus: 'active', cartesBancairesStatus: 'pending', requirementsCount: 0 })
    expect((await journal(id)).status).toBe('processed')
  })
})
