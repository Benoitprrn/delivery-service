import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'
import { createOrdersModule } from '../../src/modules/orders/public.js'
import {
  CashOnDeliveryReconciliation,
  DeliveryCompletionUseCases,
  PostgresCashOnDeliveryReconciliationRepository,
  defaultCashOnDeliveryReconciliationPolicy,
  type ReconciliationOrdersPort
} from '../../src/modules/cash-on-delivery/public.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockSeedFixture } from '../support/exclusive-fixture-lock.js'

// Chaque commande COD coûte deux bcrypt (12 tours) : large marge sous charge CPU.
vi.setConfig({ testTimeout: 120_000 })

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const createdOrderIds: string[] = []

const orders = createOrdersModule(pool, config.OSRM_URL, async () => ({ lat: 46.2, lng: 5.2 }), undefined, {
  increment: async () => undefined,
  decrement: async () => undefined
})

type CollectedOrder = { id: string; version: number }
type StartedSession = { sessionId: string; payment: { id: string } }
type LogLine = { level: 'info' | 'warn' | 'error'; message: string; [key: string]: unknown }
type PaymentRow = {
  id: string
  status: string
  stripe_charge_id: string | null
  captured_at: Date | null
  canceled_at: Date | null
  failed_at: Date | null
  failure_code: string | null
  decline_code: string | null
  stripe_payment_intent_id: string | null
}

async function collectedCodOrder(): Promise<CollectedOrder> {
  const merchantRow = await pool.query<{ id: string; name: string; zone_id: string; address: string }>(
    'select id, name, zone_id, address from merchants where id = $1',
    [merchantId]
  )
  const m = merchantRow.rows[0]!
  const created = await orders.createOrder({
    merchant: {
      id: m.id, name: m.name, zoneId: m.zone_id, address: m.address, phonePrimary: '0', phoneSecondary: null,
      logoUrl: null, lat: 46.2, lng: 5.2, onboardingCompleted: true
    },
    zone: { id: m.zone_id, name: 'z', centerLat: 46.2, centerLng: 5.2, radiusKm: 10 },
    customerName: 'C',
    customerPhone: '0600000000',
    deliveryAddress: 'D',
    deliveryLat: 46.21,
    deliveryLng: 5.21,
    pickupScheduledAt: { mode: 'asap' },
    cashOnDelivery: { amountCents: 5000 }
  })
  createdOrderIds.push(created.id)
  const assigned = await orders.assignOrder({
    orderId: created.id, driverId, expectedVersion: created.version, actor: { type: 'driver', id: driverId }
  })
  return orders.collectOrder({
    orderId: created.id, driverId, expectedVersion: assigned.version, actor: { type: 'driver', id: driverId }
  })
}

type OrdersPort = ConstructorParameters<typeof DeliveryCompletionUseCases>[1]

function buildCompletion(fake: FakeConnectPaymentsProvider, ordersPort: OrdersPort = orders): DeliveryCompletionUseCases {
  return new DeliveryCompletionUseCases(
    pool,
    ordersPort,
    fake,
    async () => 'acct_test',
    async () => ({
      id: merchantId, name: 'M', zoneId: 'z', address: 'A', phonePrimary: '0', phoneSecondary: null, logoUrl: null,
      lat: 46.2, lng: 5.2, onboardingCompleted: true
    }),
    async () => ({
      merchantId, siret: '1', siren: '1', legalName: 'M',
      legalAddress: { line1: '1 rue', line2: null, postalCode: '01000', city: 'Bourg', countryCode: 'FR', communeCode: null },
      billingAddress: null, vatNumber: null, buyerReference: null, sireneVerificationStatus: 'verified', sireneVerifiedAt: null
    }),
    true
  )
}

async function startSession(completion: DeliveryCompletionUseCases, order: CollectedOrder): Promise<StartedSession> {
  const code = (await orders.getMerchantOrders(merchantId)).find((o) => o.id === order.id)!.deliveryCode!
  return (await completion.create({
    orderId: order.id,
    driverId,
    expectedVersion: order.version,
    deliveryCode: code,
    readerFamily: 'simulated_bluetooth',
    correlationId: randomUUID()
  })) as StartedSession
}

function buildReconciliation(
  fake: FakeConnectPaymentsProvider,
  options: { pool?: Pool; orders?: ReconciliationOrdersPort } = {}
) {
  const logs: LogLine[] = []
  const record = (level: LogLine['level']) => (object: Record<string, unknown>, message: string) => {
    logs.push({ level, message, ...object })
  }
  const reconciliation = new CashOnDeliveryReconciliation({
    repository: new PostgresCashOnDeliveryReconciliationRepository(options.pool ?? pool),
    provider: fake,
    orders: options.orders ?? orders,
    logger: { info: record('info'), warn: record('warn'), error: record('error') }
  })
  return { reconciliation, logs }
}

/** Vieillit la session (expirée depuis 1 h) et le paiement (créé il y a 3 h, sans activité depuis 2 h). */
async function makeStale(orderId: string): Promise<void> {
  await pool.query("update order_delivery_completion_sessions set expires_at = now() - interval '1 hour' where order_id = $1", [orderId])
  await pool.query(
    "update order_cash_on_delivery_payments set created_at = now() - interval '3 hours', updated_at = now() - interval '2 hours' where order_id = $1",
    [orderId]
  )
}

async function paymentOf(orderId: string): Promise<PaymentRow> {
  const result = await pool.query<PaymentRow>(
    'select * from order_cash_on_delivery_payments where order_id = $1 order by attempt_no desc limit 1',
    [orderId]
  )
  return result.rows[0]!
}

async function orderOf(orderId: string): Promise<{ status: string; version: number; cash_on_delivery_collected_at: Date | null }> {
  const result = await pool.query<{ status: string; version: number; cash_on_delivery_collected_at: Date | null }>(
    'select status, version, cash_on_delivery_collected_at from orders where id = $1',
    [orderId]
  )
  return result.rows[0]!
}

async function sessionStatuses(orderId: string): Promise<string[]> {
  const result = await pool.query<{ status: string }>(
    'select status from order_delivery_completion_sessions where order_id = $1 order by created_at', [orderId]
  )
  return result.rows.map((row) => row.status)
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n)
}

function markCaptured(fake: FakeConnectPaymentsProvider, intentId: string): void {
  const stored = fake.intents.get(intentId)!
  stored.status = 'succeeded'
  stored.amountReceivedCents = stored.amountCents
  stored.chargeId = `ch_${intentId}`
}

/** Une commande COD `COLLECTED` avec session, paiement et PaymentIntent (`pi_n`) créés par `create`. */
async function startedOrder(fake: FakeConnectPaymentsProvider, completion = buildCompletion(fake)) {
  const order = await collectedCodOrder()
  const session = await startSession(completion, order)
  const payment = await paymentOf(order.id)
  return { order, session, payment, intentId: payment.stripe_payment_intent_id! }
}

let unlockFixture: () => Promise<void>
beforeAll(async () => { unlockFixture = await lockSeedFixture(pool) }, 180_000)
afterAll(async () => { await unlockFixture() })
afterEach(async () => {
  await deleteTestOrders(pool, createdOrderIds.splice(0))
  await pool.query('delete from merchant_terminal_locations where merchant_id = $1', [merchantId])
})

describe('COD reconciliation - abandoned authorizations', () => {
  it('cancels an abandoned authorization with a deterministic idempotency key and leaves the order COLLECTED', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, payment, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    const summary = await reconciliation.reconcileCashOnDeliveryPayments()

    expect(summary).toMatchObject({ claimed: 1, failures: 0, outcomes: { canceled: 1 } })
    expect(fake.intents.get(intentId)!.status).toBe('canceled')
    expect(fake.cancelKeysUsed).toEqual([`cod-cancel-${payment.id}`])
    expect(fake.calls.capturePaymentIntent).toBe(0)
    const after = await paymentOf(order.id)
    expect(after.status).toBe('canceled')
    expect(after.canceled_at).not.toBeNull()
    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED', cash_on_delivery_collected_at: null })
    expect(logs.filter((line) => line.level === 'error')).toEqual([])
  })

  it('does not touch an authorization whose session is still live or within the grace period', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    // Session expirée depuis 5 minutes seulement : sous le délai de grâce de 20 minutes.
    await pool.query("update order_delivery_completion_sessions set expires_at = now() - interval '5 minutes' where order_id = $1", [order.id])
    await pool.query("update order_cash_on_delivery_payments set created_at = now() - interval '3 hours', updated_at = now() - interval '2 hours' where order_id = $1", [order.id])
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    expect(fake.calls.retrievePaymentIntent).toBe(0)
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    expect(fake.intents.get(intentId)!.status).toBe('requires_capture')
  })

  it('a webhook-driven reconcile of a fresh authorization records authorized and never cancels it', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    const { reconciliation } = buildReconciliation(fake)

    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('authorized')
    expect((await paymentOf(order.id)).status).toBe('authorized')
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    // Deuxième appel (doublon de webhook) : rien à faire.
    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('unchanged')
    expect(fake.intents.get(intentId)!.status).toBe('requires_capture')
  })

  it('skips the cancellation when the driver resumed the session after the claim', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    await makeStale(order.id)
    const retrieve = fake.retrievePaymentIntent.bind(fake)
    fake.retrievePaymentIntent = async (input) => {
      const answer = await retrieve(input)
      // Le livreur reprend une session vivante pendant la lecture Stripe.
      await pool.query("update order_delivery_completion_sessions set expires_at = now() + interval '15 minutes' where order_id = $1", [order.id])
      return answer
    }
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1, outcomes: { unchanged: 1 } })
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    expect(fake.intents.get(intentId)!.status).toBe('requires_capture')
    expect((await paymentOf(order.id)).status).toBe('intent_created')
  })

  it('completes instead of cancelling when the card was captured between the read and the cancellation', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, payment, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    await makeStale(order.id)
    const cancel = fake.cancelPaymentIntent.bind(fake)
    fake.cancelPaymentIntent = async (input) => {
      // La capture du livreur passe juste avant l'annulation.
      await fake.capturePaymentIntent({ accountId: input.accountId, paymentIntentId: input.paymentIntentId, idempotencyKey: `cod-capture-${payment.id}` })
      return cancel(input)
    }
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { completed: 1 } })
    expect(fake.captureKeysUsed).toEqual([`cod-capture-${payment.id}`])
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
    expect((await paymentOf(order.id)).status).toBe('captured')
  })
})

describe('COD reconciliation - stale unauthorized PaymentIntents', () => {
  it('cancels a stale requires_payment_method PaymentIntent and marks the payment canceled', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { canceled: 1 } })
    expect(fake.intents.get(intentId)!.status).toBe('canceled')
    expect((await paymentOf(order.id)).status).toBe('canceled')
  })

  it('keeps the decline as failed with its codes', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.decline(intentId, 'insufficient_funds')
    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { failed: 1 } })
    expect(await paymentOf(order.id)).toMatchObject({ status: 'failed', failure_code: 'card_declined', decline_code: 'insufficient_funds' })
    expect(fake.intents.get(intentId)!.status).toBe('canceled')
  })

  it('does not cancel a still-fresh unauthorized PaymentIntent from a webhook-driven reconcile', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    const { reconciliation } = buildReconciliation(fake)

    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('unchanged')
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    expect((await paymentOf(order.id)).status).toBe('intent_created')
  })

  it('mirrors a PaymentIntent already canceled on the Stripe side without another cancellation', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.intents.get(intentId)!.status = 'canceled'
    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { canceled: 1 } })
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    expect((await paymentOf(order.id)).status).toBe('canceled')
  })

  it('cancels locally an abandoned payment that never recorded a PaymentIntent', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order } = await startedOrder(fake)
    await pool.query("update order_cash_on_delivery_payments set status = 'created', stripe_payment_intent_id = null where order_id = $1", [order.id])
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { canceled: 1 } })
    expect(fake.calls.retrievePaymentIntent).toBe(0)
    expect((await paymentOf(order.id)).status).toBe('canceled')
    expect(logs.some((line) => line.event === 'cod_reconciliation_payment_without_intent')).toBe(true)
  })

  it('marks the payment failed and logs an error when the PaymentIntent no longer exists, without completing', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.intents.delete(intentId)
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { failed: 1 } })
    expect(await paymentOf(order.id)).toMatchObject({ status: 'failed', failure_code: 'resource_missing' })
    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED' })
    expect(logs.some((line) => line.level === 'error' && line.event === 'cod_reconciliation_payment_intent_missing')).toBe(true)
  })
})

describe('COD reconciliation - captured PaymentIntents', () => {
  it('completes payment, session and order in one go and never captures again', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1, outcomes: { completed: 1 } })

    expect(fake.calls.capturePaymentIntent).toBe(0)
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
    expect((await orderOf(order.id)).cash_on_delivery_collected_at).not.toBeNull()
    const payment = await paymentOf(order.id)
    expect(payment).toMatchObject({ status: 'captured', stripe_charge_id: `ch_${intentId}` })
    expect(payment.captured_at).not.toBeNull()
    expect(await sessionStatuses(order.id)).toEqual(['completed'])
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED' and actor_type = 'system'", [order.id])).toBe(1)
    expect(await count("select count(*) n from outbox_event where aggregate_id = $1 and event_type = 'order.completed.v1'", [order.id])).toBe(1)
    expect(logs.filter((line) => line.level === 'error')).toEqual([])
  })

  it('is idempotent: a rerun and a duplicate webhook do nothing and call no Stripe API', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)
    await reconciliation.reconcileCashOnDeliveryPayments()
    const retrievesAfterFirstRun = fake.calls.retrievePaymentIntent

    // Le paiement est `captured` : il n'est plus candidat, même vieilli.
    await makeStale(order.id)
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('already_final')
    expect(fake.calls.retrievePaymentIntent).toBe(retrievesAfterFirstRun)
    expect(fake.calls.capturePaymentIntent).toBe(0)
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    expect(await count("select count(*) n from outbox_event where aggregate_id = $1 and event_type = 'order.completed.v1'", [order.id])).toBe(1)
  })

  it('recovers a crash after capture: finalize captured but the DB commit failed, the reconciler completes without a second capture', async () => {
    const fake = new FakeConnectPaymentsProvider()
    let failOnce = true
    const crashing: OrdersPort = {
      findOrderForDriver: orders.findOrderForDriver,
      verifyDeliveryCodeForCompletion: orders.verifyDeliveryCodeForCompletion,
      completeOrder: orders.completeOrder,
      releaseDriverCapacity: orders.releaseDriverCapacity,
      completeCollectedCashOnDeliveryInTransaction: async (client, input) => {
        if (failOnce) {
          failOnce = false
          throw new Error('simulated crash after capture')
        }
        return orders.completeCollectedCashOnDeliveryInTransaction(client, input)
      }
    }
    const completion = buildCompletion(fake, crashing)
    const { order, session, payment, intentId } = await startedOrder(fake, completion)
    fake.authorize(intentId)
    await expect(completion.finalize({ orderId: order.id, driverId, sessionId: session.sessionId, paymentId: payment.id, correlationId: randomUUID() }))
      .rejects.toThrow('simulated crash after capture')
    expect(fake.calls.capturePaymentIntent).toBe(1)
    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED' })
    expect((await paymentOf(order.id)).status).not.toBe('captured')

    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { completed: 1 } })

    expect(fake.calls.capturePaymentIntent).toBe(1)
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
    expect((await paymentOf(order.id)).status).toBe('captured')
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    // Un finalize rejoué par le livreur retombe sur la session déjà complétée : pas de nouvelle capture.
    await expect(completion.finalize({ orderId: order.id, driverId, sessionId: session.sessionId, paymentId: payment.id, correlationId: randomUUID() }))
      .resolves.toMatchObject({ status: 'completed' })
    expect(fake.calls.capturePaymentIntent).toBe(1)
  })

  it('releases the driver capacity once after a reconciled completion, and survives a release failure', async () => {
    const released: string[] = []
    const fake = new FakeConnectPaymentsProvider()
    const first = await startedOrder(fake)
    markCaptured(fake, first.intentId)
    await makeStale(first.order.id)
    const spy = buildReconciliation(fake, {
      orders: {
        completeCollectedCashOnDeliveryInTransaction: orders.completeCollectedCashOnDeliveryInTransaction,
        releaseDriverCapacity: async (id) => { released.push(id) }
      }
    })
    await spy.reconciliation.reconcileCashOnDeliveryPayments()
    expect(released).toEqual([driverId])

    const second = await startedOrder(fake)
    markCaptured(fake, second.intentId)
    await makeStale(second.order.id)
    const failing = buildReconciliation(fake, {
      orders: {
        completeCollectedCashOnDeliveryInTransaction: orders.completeCollectedCashOnDeliveryInTransaction,
        releaseDriverCapacity: async () => { throw new Error('valkey down') }
      }
    })
    expect(await failing.reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { completed: 1 }, failures: 0 })
    expect(await orderOf(second.order.id)).toMatchObject({ status: 'COMPLETED' })
    expect(failing.logs.some((line) => line.level === 'warn' && line.event === 'cod_reconciliation_release_capacity_failed')).toBe(true)
  })

  it('completes from a Connect webhook path even while the session is still live', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    const { reconciliation } = buildReconciliation(fake)

    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('completed')
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
    expect(fake.calls.capturePaymentIntent).toBe(0)
    await expect(reconciliation.reconcilePaymentIntent(intentId)).resolves.toBe('already_final')
  })

  it('returns not_found for a PaymentIntent unknown locally', async () => {
    const { reconciliation } = buildReconciliation(new FakeConnectPaymentsProvider())
    await expect(reconciliation.reconcilePaymentIntent('pi_never_seen')).resolves.toBe('not_found')
  })

  it('completes even when the driver had already resumed a replacement session (session expired lazily)', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const completion = buildCompletion(fake)
    const { order, intentId } = await startedOrder(fake, completion)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    // Le livreur a repris : ancienne session expirée, nouvelle session active liée au paiement.
    await startSession(completion, { id: order.id, version: order.version })
    await pool.query("update order_delivery_completion_sessions set expires_at = now() - interval '1 hour' where order_id = $1", [order.id])
    await pool.query("update order_cash_on_delivery_payments set updated_at = now() - interval '2 hours' where order_id = $1", [order.id])
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { completed: 1 } })
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
    const statuses = await sessionStatuses(order.id)
    expect(statuses).toContain('completed')
  })

  it('records the capture but never forces the order when it is no longer completable', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    // La version de la commande a changé depuis la session.
    await pool.query('update orders set version = version + 1 where id = $1', [order.id])
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { needs_review: 1 } })

    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED', cash_on_delivery_collected_at: null })
    expect(await paymentOf(order.id)).toMatchObject({ status: 'captured', stripe_charge_id: `ch_${intentId}` })
    expect(await sessionStatuses(order.id)).not.toContain('completed')
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(0)
    const review = logs.find((line) => line.event === 'cod_reconciliation_captured_order_not_completable')
    expect(review).toMatchObject({ level: 'error', manualReviewRequired: true, paymentId: (await paymentOf(order.id)).id })
    expect(fake.calls.capturePaymentIntent).toBe(0)
  })

  it('flags a duplicate capture for human review instead of recording a second captured payment', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, session, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    await pool.query('update orders set version = version + 1 where id = $1', [order.id])
    // Une autre tentative a déjà encaissé cette commande.
    await pool.query(
      `insert into order_cash_on_delivery_payments(order_id, session_id, merchant_id, driver_id, attempt_no, stripe_account_id, amount_cents, currency, status,
         stripe_payment_intent_id, stripe_charge_id, capture_idempotency_key, create_idempotency_key, reader_type, terminal_location_id)
       values ($1, $2, $3, $4, 2, 'acct_test', 5000, 'eur', 'captured', 'pi_other_attempt', 'ch_other_attempt', $5, $6, 'bluetooth', 'tml_test')`,
      [order.id, session.sessionId, merchantId, driverId, `cap-${randomUUID()}`, `cre-${randomUUID()}`]
    )
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { needs_review: 1 } })

    const rows = await pool.query<{ attempt_no: number; status: string }>(
      'select attempt_no, status from order_cash_on_delivery_payments where order_id = $1 order by attempt_no', [order.id]
    )
    expect(rows.rows).toEqual([{ attempt_no: 1, status: 'intent_created' }, { attempt_no: 2, status: 'captured' }])
    expect(logs.find((line) => line.event === 'cod_reconciliation_captured_order_not_completable')).toMatchObject({
      level: 'error', reason: 'another_payment_already_captured_for_order'
    })
  })
})

describe('COD reconciliation - contaminated PaymentIntents', () => {
  it.each<[string, (fake: FakeConnectPaymentsProvider, intentId: string) => void]>([
    ['wrong amount', (fake, id) => { fake.intents.get(id)!.amountCents = 100; fake.intents.get(id)!.amountReceivedCents = 100 }],
    ['wrong payment metadata', (fake, id) => { fake.intents.get(id)!.metadata.payment_id = randomUUID() }],
    ['wrong order metadata', (fake, id) => { fake.intents.get(id)!.metadata.order_id = randomUUID() }],
    ['platform fee', (fake, id) => { fake.intents.get(id)!.applicationFeeAmountCents = 50 }],
    ['transfer data', (fake, id) => { fake.intents.get(id)!.hasTransferData = true }],
    ['captured amount differs', (fake, id) => { fake.intents.get(id)!.amountReceivedCents = 1234 }]
  ])('never completes a captured PaymentIntent with %s: marks unknown and logs a security error', async (_label, contaminate) => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    contaminate(fake, intentId)
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { marked_unknown: 1 } })

    expect((await paymentOf(order.id)).status).toBe('unknown')
    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED', cash_on_delivery_collected_at: null })
    expect(fake.calls.capturePaymentIntent).toBe(0)
    expect(fake.calls.cancelPaymentIntent).toBe(0)
    const alert = logs.find((line) => line.event === 'cod_reconciliation_payment_intent_mismatch')
    expect(alert).toMatchObject({ level: 'error', securityAlert: true })
    expect(alert!.mismatches).toEqual(expect.any(Array))
  })

  it('does not cancel a contaminated authorization either, and keeps re-flagging it on later cycles', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    fake.intents.get(intentId)!.metadata.payment_id = randomUUID()
    await makeStale(order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    await reconciliation.reconcileCashOnDeliveryPayments()
    expect((await paymentOf(order.id)).status).toBe('unknown')
    expect(fake.calls.cancelPaymentIntent).toBe(0)

    // `unknown` reste candidat : le prochain cycle (après le délai de reprise) le signale encore.
    await pool.query("update order_cash_on_delivery_payments set updated_at = now() - interval '7 hours' where order_id = $1", [order.id])
    await reconciliation.reconcileCashOnDeliveryPayments()
    expect(logs.filter((line) => line.event === 'cod_reconciliation_payment_intent_mismatch')).toHaveLength(2)
  })
})

describe('COD reconciliation - orphaned PaymentIntents of failed/canceled payments', () => {
  it('cancels a live PaymentIntent left behind by a failed best-effort cancellation and keeps the local status', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    await pool.query("update order_cash_on_delivery_payments set status = 'canceled', canceled_at = now() - interval '1 hour', updated_at = now() - interval '1 hour', created_at = now() - interval '3 hours' where order_id = $1", [order.id])
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1, outcomes: { canceled: 1 } })
    expect(fake.intents.get(intentId)!.status).toBe('canceled')
    expect((await paymentOf(order.id)).status).toBe('canceled')
  })

  it('never resurrects a canceled local payment whose PaymentIntent was captured: logs for human review', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await pool.query("update order_cash_on_delivery_payments set status = 'canceled', canceled_at = now() - interval '1 hour', updated_at = now() - interval '1 hour', created_at = now() - interval '3 hours' where order_id = $1", [order.id])
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ outcomes: { needs_review: 1 } })
    expect((await paymentOf(order.id)).status).toBe('canceled')
    expect(await orderOf(order.id)).toMatchObject({ status: 'COLLECTED' })
    expect(logs.find((line) => line.event === 'cod_reconciliation_captured_on_terminal_payment')).toMatchObject({ level: 'error', manualReviewRequired: true })
  })

  it('stops rechecking a terminal payment once the Stripe authorization window has passed', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order } = await startedOrder(fake)
    await pool.query("update order_cash_on_delivery_payments set status = 'failed', failed_at = now() - interval '3 days', updated_at = now() - interval '3 days', created_at = now() - interval '4 days' where order_id = $1", [order.id])
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
  })
})

describe('COD reconciliation - lease, backoff and concurrency', () => {
  it('lets exactly one of several concurrent workers process a payment', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.authorize(intentId)
    await makeStale(order.id)
    fake.retrieveDelayMs = 150
    const workers = Array.from({ length: 4 }, () => buildReconciliation(fake).reconciliation)

    const summaries = await Promise.all(workers.map((worker) => worker.reconcileCashOnDeliveryPayments()))

    expect(summaries.reduce((total, summary) => total + summary.claimed, 0)).toBe(1)
    expect(fake.calls.retrievePaymentIntent).toBe(1)
    expect(fake.calls.cancelPaymentIntent).toBe(1)
    expect((await paymentOf(order.id)).status).toBe('canceled')
  })

  it('lets exactly one of several concurrent workers complete a captured payment', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    fake.retrieveDelayMs = 100
    const workers = Array.from({ length: 4 }, () => buildReconciliation(fake).reconciliation)

    await Promise.all(workers.map((worker) => worker.reconcileCashOnDeliveryPayments()))

    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    expect(await count("select count(*) n from outbox_event where aggregate_id = $1 and event_type = 'order.completed.v1'", [order.id])).toBe(1)
    expect(fake.calls.capturePaymentIntent).toBe(0)
  })

  it('a webhook reconcile racing the worker completes the order exactly once', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    markCaptured(fake, intentId)
    await makeStale(order.id)
    fake.retrieveDelayMs = 100
    const { reconciliation } = buildReconciliation(fake)

    const results = await Promise.all([
      reconciliation.reconcileCashOnDeliveryPayments(),
      reconciliation.reconcilePaymentIntent(intentId),
      reconciliation.reconcilePaymentIntent(intentId)
    ])

    const outcomes = [results[1], results[2]]
    expect(outcomes.filter((outcome) => outcome === 'completed').length + (results[0].outcomes.completed ?? 0)).toBe(1)
    // Les perdants de la course constatent un paiement déjà encaissé : jamais une « revue humaine ».
    expect(outcomes).not.toContain('needs_review')
    expect(results[0].outcomes.needs_review).toBeUndefined()
    expect(results[0].failures).toBe(0)
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    expect(await orderOf(order.id)).toMatchObject({ status: 'COMPLETED' })
  })

  it('leases a claimed payment: an immediate rerun skips it until the retry delay elapses', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    fake.intents.get(intentId)!.status = 'processing'
    await makeStale(order.id)
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1, outcomes: { unchanged: 1 } })
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    expect(fake.calls.retrievePaymentIntent).toBe(1)

    await pool.query("update order_cash_on_delivery_payments set updated_at = now() - interval '2 hours' where order_id = $1", [order.id])
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1 })
    expect(fake.calls.retrievePaymentIntent).toBe(2)
  })

  it('grows the retry delay with the age of the payment, bounded by the policy', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const { order, intentId } = await startedOrder(fake)
    // `processing` : Stripe n'a pas tranché, le paiement reste candidat d'un cycle à l'autre.
    fake.intents.get(intentId)!.status = 'processing'
    await pool.query("update order_delivery_completion_sessions set expires_at = now() - interval '1 hour' where order_id = $1", [order.id])
    const { reconciliation } = buildReconciliation(fake)
    const setAges = (created: string, idle: string) => pool.query(
      `update order_cash_on_delivery_payments set created_at = now() - interval '${created}', updated_at = now() - interval '${idle}' where order_id = $1`,
      [order.id]
    )

    // 3 h d'âge : délai de reprise = 45 min.
    await setAges('3 hours', '30 minutes')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    await setAges('3 hours', '50 minutes')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1 })
    // 2 jours d'âge : 12 h bornés à 6 h.
    await setAges('2 days', '5 hours')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    await setAges('2 days', '7 hours')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1 })
    // Jeune paiement : plancher de 5 min.
    await setAges('30 minutes', '4 minutes')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
    await setAges('30 minutes', '6 minutes')
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 1 })
  })

  it('isolates a failing payment: the others still reconcile, the failure is logged without secrets and retried later', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const first = await startedOrder(fake)
    const second = await startedOrder(fake)
    fake.authorize(first.intentId)
    fake.authorize(second.intentId)
    await makeStale(first.order.id)
    await makeStale(second.order.id)
    const retrieve = fake.retrievePaymentIntent.bind(fake)
    fake.retrievePaymentIntent = async (input) => {
      if (input.paymentIntentId === first.intentId) throw new Error(`network down ${first.intentId}_secret`)
      return retrieve(input)
    }
    const { reconciliation, logs } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 2, failures: 1, outcomes: { canceled: 1 } })

    expect((await paymentOf(first.order.id)).status).toBe('intent_created')
    expect((await paymentOf(second.order.id)).status).toBe('canceled')
    const failure = logs.find((line) => line.event === 'cod_reconciliation_payment_failed')
    expect(failure).toMatchObject({ level: 'error', paymentId: first.payment.id, errorClass: 'Error' })
    expect(JSON.stringify(logs)).not.toContain('_secret')
    // Le bail repousse la reprise : pas de boucle serrée sur le paiement défaillant.
    expect(await reconciliation.reconcileCashOnDeliveryPayments()).toMatchObject({ claimed: 0 })
  })

  it('claims at most the requested batch size, oldest first', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const first = await startedOrder(fake)
    const second = await startedOrder(fake)
    await makeStale(first.order.id)
    await makeStale(second.order.id)
    await pool.query("update order_cash_on_delivery_payments set updated_at = now() - interval '3 hours' where order_id = $1", [first.order.id])
    const { reconciliation } = buildReconciliation(fake)

    expect(await reconciliation.reconcileCashOnDeliveryPayments(1)).toMatchObject({ claimed: 1 })
    expect((await paymentOf(first.order.id)).status).toBe('canceled')
    expect((await paymentOf(second.order.id)).status).toBe('intent_created')
  })
})

describe('COD reconciliation - Stripe never runs inside a PostgreSQL transaction, and logs stay clean', () => {
  it('holds no open transaction during any provider call across every outcome', async () => {
    let openTransactions = 0
    const tracked = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect()
        openTransactions += 1
        const release = client.release.bind(client)
        client.release = ((err?: Error | boolean) => {
          openTransactions -= 1
          release(err)
        }) as typeof client.release
        return client
      }
    } as unknown as Pool

    const fake = new FakeConnectPaymentsProvider()
    const violations: string[] = []
    for (const method of ['getAccountStatus', 'ensureTerminalLocation', 'createConnectionToken', 'createTerminalPaymentIntent', 'retrievePaymentIntent', 'capturePaymentIntent', 'cancelPaymentIntent'] as const) {
      const original = (fake[method] as (...args: unknown[]) => Promise<unknown>).bind(fake)
      ;(fake as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        if (openTransactions !== 0) violations.push(method)
        return original(...args)
      }
    }

    const abandoned = await startedOrder(fake)
    fake.authorize(abandoned.intentId)
    const captured = await startedOrder(fake)
    markCaptured(fake, captured.intentId)
    const contaminated = await startedOrder(fake)
    fake.intents.get(contaminated.intentId)!.metadata.payment_id = randomUUID()
    const missing = await startedOrder(fake)
    fake.intents.delete(missing.intentId)
    for (const started of [abandoned, captured, contaminated, missing]) await makeStale(started.order.id)

    const { reconciliation } = buildReconciliation(fake, { pool: tracked })
    const summary = await reconciliation.reconcileCashOnDeliveryPayments()

    expect(summary.claimed).toBe(4)
    expect(summary.outcomes).toMatchObject({ canceled: 1, completed: 1, marked_unknown: 1, failed: 1 })
    expect(fake.calls.cancelPaymentIntent).toBe(1)
    expect(violations).toEqual([])
    expect(openTransactions).toBe(0)
  })

  it('never logs a client secret across the outcomes', async () => {
    const fake = new FakeConnectPaymentsProvider()
    const abandoned = await startedOrder(fake)
    fake.authorize(abandoned.intentId)
    const contaminated = await startedOrder(fake)
    fake.intents.get(contaminated.intentId)!.metadata.payment_id = randomUUID()
    const missing = await startedOrder(fake)
    fake.intents.delete(missing.intentId)
    for (const started of [abandoned, contaminated, missing]) await makeStale(started.order.id)
    const { reconciliation, logs } = buildReconciliation(fake)

    await reconciliation.reconcileCashOnDeliveryPayments()

    expect(logs.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toMatch(/secret/i)
    expect(serialized).not.toContain('clientSecret')
  })

  it('uses the documented default policy', () => {
    expect(defaultCashOnDeliveryReconciliationPolicy).toEqual({
      sessionGraceSeconds: 1200,
      minRetrySeconds: 300,
      maxRetrySeconds: 21_600,
      terminalRecheckWindowSeconds: 180_000
    })
  })
})
