import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'
import {
  createOrdersModule,
  DeliveryCodeInvalidError,
  DeliveryCodeLockedError
} from '../../src/modules/orders/public.js'
import {
  CompletionHttpError,
  DeliveryCompletionUseCases,
  registerCashOnDeliveryHttpRoutes
} from '../../src/modules/cash-on-delivery/public.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockSeedFixture } from '../support/exclusive-fixture-lock.js'

const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const otherDriverId = '44444444-4444-4444-4444-444444444444'
const createdOrderIds: string[] = []

const orders = createOrdersModule(pool, config.OSRM_URL, async () => ({ lat: 46.2, lng: 5.2 }), undefined, {
  increment: async () => undefined,
  decrement: async () => undefined
})

async function collectedCodOrder(): Promise<{ id: string; version: number }> {
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

async function deliveryCode(orderId: string): Promise<string> {
  return (await orders.getMerchantOrders(merchantId)).find((o) => o.id === orderId)!.deliveryCode!
}

type OrdersPort = ConstructorParameters<typeof DeliveryCompletionUseCases>[1]

function build(options: { fake?: FakeConnectPaymentsProvider; ordersPort?: OrdersPort; poolOverride?: Pool } = {}) {
  const fake = options.fake ?? new FakeConnectPaymentsProvider()
  const completion = new DeliveryCompletionUseCases(
    options.poolOverride ?? pool,
    options.ordersPort ?? orders,
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
  return { fake, completion }
}

async function startSession(completion: DeliveryCompletionUseCases, order: { id: string; version: number }) {
  return (await completion.create({
    orderId: order.id,
    driverId,
    expectedVersion: order.version,
    deliveryCode: await deliveryCode(order.id),
    readerFamily: 'simulated_bluetooth',
    correlationId: randomUUID()
  })) as { sessionId: string; payment: { id: string } }
}

function finalizeInput(orderId: string, session: { sessionId: string; payment: { id: string } }) {
  return { orderId, driverId, sessionId: session.sessionId, paymentId: session.payment.id, correlationId: randomUUID() }
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n)
}

let unlockFixture: () => Promise<void>
beforeAll(async () => { unlockFixture = await lockSeedFixture(pool) }, 180_000)
afterAll(async () => { await unlockFixture() })
afterEach(async () => {
  await deleteTestOrders(pool, createdOrderIds.splice(0))
  await pool.query('delete from merchant_terminal_locations where merchant_id = $1', [merchantId])
})

describe('COD delivery completion guards', () => {
  it('wrong code: no PaymentIntent, counter increments, third failure locks even the right code', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const attempt = (code: string) =>
      completion.create({
        orderId: order.id, driverId, expectedVersion: order.version, deliveryCode: code,
        readerFamily: 'simulated_bluetooth', correlationId: randomUUID()
      })

    await expect(attempt('000000')).rejects.toBeInstanceOf(DeliveryCodeInvalidError)
    await expect(attempt('000000')).rejects.toBeInstanceOf(DeliveryCodeInvalidError)
    await expect(attempt('000000')).rejects.toBeInstanceOf(DeliveryCodeInvalidError)
    await expect(attempt(await deliveryCode(order.id))).rejects.toBeInstanceOf(DeliveryCodeLockedError)

    expect(fake.calls.createTerminalPaymentIntent).toBe(0)
    expect(fake.calls.getAccountStatus).toBe(0)
    expect(await count('select count(*) n from order_cash_on_delivery_payments where order_id = $1', [order.id])).toBe(0)
    expect(await count('select count(*) n from order_delivery_completion_sessions where order_id = $1', [order.id])).toBe(0)
    const row = await pool.query<{ delivery_code_failed_attempts: number }>(
      'select delivery_code_failed_attempts from orders where id = $1', [order.id]
    )
    expect(row.rows[0]!.delivery_code_failed_attempts).toBe(3)
  })

  it('truly concurrent finalize: one capture, both callers complete, order completed once', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const session = await startSession(completion, order)
    fake.authorize('pi_1')
    fake.retrieveDelayMs = 40 // les 3 appels lisent « requires_capture » avant toute capture : vraie course

    const results = await Promise.allSettled([
      completion.finalize(finalizeInput(order.id, session)),
      completion.finalize(finalizeInput(order.id, session)),
      completion.finalize(finalizeInput(order.id, session))
    ])

    expect(new Set(fake.captureKeysUsed).size).toBe(1) // même clé d'idempotence pour tous les appels
    expect(fake.captureKeysUsed.length).toBeGreaterThan(1) // la course a réellement eu lieu
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    // Aucun échec autre qu'un conflit de version pour les perdants de la course.
    for (const r of results) {
      if (r.status === 'rejected') expect(String((r.reason as Error).name)).toMatch(/Conflict|PaymentNotConfirmed|SessionExpired/)
    }
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    expect(await count("select count(*) n from outbox_event where aggregate_id = $1 and event_type = 'order.completed.v1'", [order.id])).toBe(1)
    expect(await count("select count(*) n from order_cash_on_delivery_payments where order_id = $1 and status = 'captured'", [order.id])).toBe(1)
    // Rejoué après la course : toujours terminé, aucune nouvelle capture.
    const capturesBeforeReplay = fake.calls.capturePaymentIntent
    await expect(completion.finalize(finalizeInput(order.id, session))).resolves.toMatchObject({ status: 'completed' })
    expect(fake.calls.capturePaymentIntent).toBe(capturesBeforeReplay)
  })

  it('crash after capture (DB transaction fails): order stays COLLECTED, replay completes without a second capture', async () => {
    const order = await collectedCodOrder()
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
    const { fake, completion } = build({ ordersPort: crashing })
    const session = await startSession(completion, order)
    fake.authorize('pi_1')

    await expect(completion.finalize(finalizeInput(order.id, session))).rejects.toThrow('simulated crash after capture')
    expect(fake.calls.capturePaymentIntent).toBe(1)
    expect(fake.intents.get('pi_1')!.status).toBe('succeeded')
    const mid = await pool.query<{ status: string; cash_on_delivery_collected_at: Date | null }>(
      'select status, cash_on_delivery_collected_at from orders where id = $1', [order.id]
    )
    expect(mid.rows[0]).toMatchObject({ status: 'COLLECTED', cash_on_delivery_collected_at: null })
    expect(await count("select count(*) n from order_cash_on_delivery_payments where order_id = $1 and status = 'captured'", [order.id])).toBe(0)

    await expect(completion.finalize(finalizeInput(order.id, session))).resolves.toMatchObject({ status: 'completed' })
    expect(fake.calls.capturePaymentIntent).toBe(1)
    expect(await count("select count(*) n from order_events where order_id = $1 and to_status = 'COMPLETED'", [order.id])).toBe(1)
    expect(await count("select count(*) n from outbox_event where aggregate_id = $1 and event_type = 'order.completed.v1'", [order.id])).toBe(1)
  })

  it('expired session is replaced without a second PaymentIntent and stays payable and finalizable', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const first = await startSession(completion, order)
    await pool.query("update order_delivery_completion_sessions set expires_at = now() - interval '1 minute' where id = $1", [first.sessionId])

    // Le jeton Terminal est refusé pour une session expirée.
    await expect(completion.connectionToken({ orderId: order.id, driverId })).rejects.toMatchObject({ code: 'SessionExpired' })

    const second = await startSession(completion, order)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.payment.id).toBe(first.payment.id)
    expect(fake.calls.createTerminalPaymentIntent).toBe(1)
    const sessions = await pool.query<{ id: string; status: string }>(
      'select id, status from order_delivery_completion_sessions where order_id = $1', [order.id]
    )
    expect(sessions.rows.find((s) => s.id === first.sessionId)!.status).toBe('expired')
    expect(sessions.rows.find((s) => s.id === second.sessionId)!.status).toBe('payment_pending')

    await expect(completion.connectionToken({ orderId: order.id, driverId })).resolves.toHaveProperty('secret')
    fake.authorize('pi_1')
    await expect(completion.finalize(finalizeInput(order.id, second))).resolves.toMatchObject({ status: 'completed' })
    expect(fake.calls.capturePaymentIntent).toBe(1)
  })

  it('another driver cannot finalize, retry, read or get a token; nothing is captured', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const session = await startSession(completion, order)
    fake.authorize('pi_1')

    await expect(completion.finalize({ ...finalizeInput(order.id, session), driverId: otherDriverId })).rejects.toBeInstanceOf(CompletionHttpError)
    await expect(completion.retry({ orderId: order.id, driverId: otherDriverId, sessionId: session.sessionId, correlationId: randomUUID() })).rejects.toBeInstanceOf(CompletionHttpError)
    await expect(completion.get({ orderId: order.id, driverId: otherDriverId })).rejects.toMatchObject({ code: 'OrderNotFoundError' })
    await expect(completion.connectionToken({ orderId: order.id, driverId: otherDriverId })).rejects.toBeInstanceOf(CompletionHttpError)
    expect(fake.calls.capturePaymentIntent).toBe(0)
    expect(fake.calls.createConnectionToken).toBe(0)
  })

  describe('PaymentIntent missing on the connected account', () => {
    it('resume (create) marks the payment unknown and answers PaymentNotConfirmed', async () => {
      const order = await collectedCodOrder()
      const { fake, completion } = build()
      const session = await startSession(completion, order)
      fake.intents.delete('pi_1')
      await expect(startSession(completion, order)).rejects.toMatchObject({ code: 'PaymentNotConfirmed', statusCode: 409 })
      const row = await pool.query<{ status: string }>('select status from order_cash_on_delivery_payments where id = $1', [session.payment.id])
      expect(row.rows[0]!.status).toBe('unknown')
    })

    it('GET answers retry_payment without a client secret', async () => {
      const order = await collectedCodOrder()
      const { fake, completion } = build()
      await startSession(completion, order)
      fake.intents.delete('pi_1')
      const state = (await completion.get({ orderId: order.id, driverId })) as { nextAction: string; payment: { paymentIntentClientSecret: string | null } }
      expect(state.nextAction).toBe('retry_payment')
      expect(state.payment.paymentIntentClientSecret).toBeNull()
    })

    it('retry cancels the lost attempt and opens attempt 2 (never two active payments)', async () => {
      const order = await collectedCodOrder()
      const { fake, completion } = build()
      const session = await startSession(completion, order)
      fake.intents.delete('pi_1')
      const retried = (await completion.retry({ orderId: order.id, driverId, sessionId: session.sessionId, correlationId: randomUUID() })) as { payment: { id: string } }
      expect(retried.payment.id).not.toBe(session.payment.id)
      const rows = await pool.query<{ attempt_no: number; status: string }>(
        'select attempt_no, status from order_cash_on_delivery_payments where order_id = $1 order by attempt_no', [order.id]
      )
      expect(rows.rows.map((r) => [r.attempt_no, r.status])).toEqual([[1, 'canceled'], [2, 'intent_created']])
    })

    it('finalize keeps answering PaymentNotConfirmed and never completes the order', async () => {
      const order = await collectedCodOrder()
      const { fake, completion } = build()
      const session = await startSession(completion, order)
      fake.intents.delete('pi_1')
      await expect(completion.finalize(finalizeInput(order.id, session))).rejects.toMatchObject({ code: 'PaymentNotConfirmed' })
      const row = await pool.query<{ status: string }>('select status from orders where id = $1', [order.id])
      expect(row.rows[0]!.status).toBe('COLLECTED')
    })
  })

  it('retry stores a Stripe decline, keeps abandon canceled, and exposes declineCode', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const session = await startSession(completion, order)
    fake.decline('pi_1', 'generic_decline')
    await expect(completion.get({ orderId: order.id, driverId })).resolves.toMatchObject({
      nextAction: 'retry_payment', payment: { declineCode: 'generic_decline' }
    })
    await completion.retry({ orderId: order.id, driverId, sessionId: session.sessionId, correlationId: randomUUID() })
    const rows = await pool.query<{ attempt_no: number; status: string; failure_code: string | null; decline_code: string | null }>(
      'select attempt_no, status, failure_code, decline_code from order_cash_on_delivery_payments where order_id = $1 order by attempt_no', [order.id]
    )
    expect(rows.rows.map((r) => [r.attempt_no, r.status, r.failure_code, r.decline_code])).toEqual([[1, 'failed', 'card_declined', 'generic_decline'], [2, 'intent_created', null, null]])
    expect(fake.intents.get('pi_1')!.status).toBe('canceled')

    // Même faux fournisseur : ses identifiants de PI continuent (unicité de stripe_payment_intent_id en base).
    const abandonedOrder = await collectedCodOrder()
    const abandonedSession = await startSession(completion, abandonedOrder)
    await completion.retry({ orderId: abandonedOrder.id, driverId, sessionId: abandonedSession.sessionId, correlationId: randomUUID() })
    const abandonedRow = (await pool.query<{ status: string; stripe_payment_intent_id: string }>('select status, stripe_payment_intent_id from order_cash_on_delivery_payments where id = $1', [abandonedSession.payment.id])).rows[0]!
    expect(abandonedRow.status).toBe('canceled')
    expect(fake.intents.get(abandonedRow.stripe_payment_intent_id)!.status).toBe('canceled')
  })

  it('retry refuses to open a new attempt when the previous PaymentIntent already succeeded (no double charge)', async () => {
    const order = await collectedCodOrder()
    const { fake, completion } = build()
    const session = await startSession(completion, order)
    fake.authorize('pi_1')
    fake.intents.get('pi_1')!.status = 'succeeded'
    await expect(
      completion.retry({ orderId: order.id, driverId, sessionId: session.sessionId, correlationId: randomUUID() })
    ).rejects.toMatchObject({ code: 'PaymentNotConfirmed' })
    expect(fake.calls.createTerminalPaymentIntent).toBe(1)
    expect(await count('select count(*) n from order_cash_on_delivery_payments where order_id = $1', [order.id])).toBe(1)
  })

  it('never calls Stripe while a PostgreSQL transaction opened by the use case is in flight', async () => {
    const order = await collectedCodOrder()
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
    const { completion } = build({ fake, poolOverride: tracked })
    const session = await startSession(completion, order)
    await completion.connectionToken({ orderId: order.id, driverId })
    await completion.get({ orderId: order.id, driverId })
    fake.decline('pi_1')
    await expect(completion.finalize(finalizeInput(order.id, session))).rejects.toMatchObject({ code: 'PaymentDeclined' })
    const retried = (await completion.retry({ orderId: order.id, driverId, sessionId: session.sessionId, correlationId: randomUUID() })) as { payment: { id: string } }
    fake.authorize('pi_2')
    await completion.finalize({ ...finalizeInput(order.id, session), paymentId: retried.payment.id })
    expect(fake.calls.capturePaymentIntent).toBe(1)
    expect(violations).toEqual([])
  })
})

describe('COD terminal connection-token HTTP guards', () => {
  async function httpApp(logLines: string[]) {
    const order = await collectedCodOrder()
    const { completion } = build()
    await startSession(completion, order)
    let actingDriver = driverId
    const app = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => void logLines.push(line) } }
    })
    app.addHook('onRequest', async (request) => {
      request.correlationId = randomUUID()
      request.authUser = { id: actingDriver, role: 'driver' }
    })
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
    await app.register(registerCashOnDeliveryHttpRoutes, { completion })
    return { app, order, asDriver: (id: string) => { actingDriver = id } }
  }

  it('rate-limits 30 tokens per minute per driver, and keys the limit on the driver', async () => {
    const { app, order, asDriver } = await httpApp([])
    try {
      const call = () => app.inject({ method: 'POST', url: `/api/v1/orders/${order.id}/terminal/connection-token` })
      const statuses: number[] = []
      for (let i = 0; i < 31; i += 1) statuses.push((await call()).statusCode)
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
      expect(statuses[30]).toBe(429)
      // Un autre livreur n'est pas bloqué par le quota du premier (rejeté pour propriété, pas pour quota).
      asDriver(otherDriverId)
      expect((await call()).statusCode).not.toBe(429)
    } finally {
      await app.close()
    }
  })

  it('reproduces the mobile 400 when JSON is declared without a body', async () => {
    const { app, order } = await httpApp([])
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${order.id}/terminal/connection-token`,
        headers: { 'content-type': 'application/json' }
      })
      expect(response.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('accepts an explicit empty JSON object from the mobile connection-token request', async () => {
    const { app, order } = await httpApp([])
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${order.id}/terminal/connection-token`,
        payload: {}
      })
      expect(response.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('never writes the connection-token secret to logs', async () => {
    const logLines: string[] = []
    const { app, order } = await httpApp(logLines)
    try {
      const response = await app.inject({ method: 'POST', url: `/api/v1/orders/${order.id}/terminal/connection-token` })
      expect(response.statusCode).toBe(200)
      const secret = (response.json() as { secret: string }).secret
      expect(secret).toMatch(/^pst_/)
      expect(logLines.length).toBeGreaterThan(0)
      expect(logLines.some((line) => line.includes('Stripe Terminal connection token created'))).toBe(true)
      expect(logLines.join('\n')).not.toContain(secret)
    } finally {
      await app.close()
    }
  })
})
