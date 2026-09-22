import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { createOrdersModule } from '../../src/modules/orders/public.js'
import { config } from '../../src/platform/config.js'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { getDriverAccessToken } from '../support/get-driver-access-token.js'
import { getMerchantAccessToken } from '../support/get-merchant-access-token.js'
import { FakeConnectPaymentsProvider } from '../support/fake-connect-payments-provider.js'

const zoneId = '11111111-1111-1111-1111-111111111111'
const merchantId = '22222222-2222-2222-2222-222222222222'
const driverId = '33333333-3333-3333-3333-333333333333'
const createdOrderIds: string[] = []
const orders = createOrdersModule(pool, config.OSRM_URL, async () => ({ lat: 46.2058, lng: 5.2255 }))

let app: FastifyInstance
let merchantAccessToken: string
let driverAccessToken: string

// La création d'une commande COD exige `card_payments` actif : le provider Connect est un fake
// (aucun réseau Stripe) et le restaurant de test reçoit un profil Account uniquement pour la durée du fichier.
const activeCardPayments = new FakeConnectPaymentsProvider()
let seededPaymentProfile = false
let seededConnectCache = false

async function createValidOrder(
  pickupScheduledAt: unknown = { mode: 'asap' },
  cashOnDelivery?: unknown
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/orders',
    headers: { authorization: `Bearer ${merchantAccessToken}` },
    payload: {
      merchantId,
      customerName: 'Client de test',
      customerPhone: '0000000000',
      pickupScheduledAt,
      orderDetails: 'Deux sacs',
      deliveryInstructions: 'Sonnez',
      deliveryAddressComplement: 'Bâtiment B',
      deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
      deliveryLat: 46.21,
      deliveryLng: 5.23,
      ...(cashOnDelivery === undefined ? {} : { cashOnDelivery })
    }
  })

  expect(response.statusCode).toBe(201)
  const order = response.json() as Record<string, unknown>
  createdOrderIds.push(order.id as string)
  return order
}

// D-D (ADR 0004) : ces tests créent des commandes sans données de règlement en base ; la garde réelle est testée séparément.
const settlementReady = { check: async () => ({ ready: true as const }) }
const driverEligible = { isEligible: async () => true }

describe('orders HTTP endpoints', () => {
  beforeAll(async () => {
    merchantAccessToken = await getMerchantAccessToken()
    driverAccessToken = await getDriverAccessToken()
    const profile = await pool.query(
      `insert into merchant_payment_profiles (merchant_id, stripe_account_id)
       values ($1, 'acct_orders_http_test') on conflict (merchant_id) do nothing`,
      [merchantId]
    )
    seededPaymentProfile = profile.rowCount === 1
    const cache = await pool.query('select 1 from merchant_stripe_connect where merchant_id = $1', [merchantId])
    seededConnectCache = cache.rowCount === 0
  })

  afterAll(async () => {
    if (seededConnectCache) {
      await pool.query('delete from merchant_stripe_connect where merchant_id = $1', [merchantId])
    }
    if (seededPaymentProfile) {
      await pool.query('delete from merchant_payment_profiles where merchant_id = $1', [merchantId])
    }
  })

  beforeEach(async () => {
    app = await buildApp({ connectProvider: activeCardPayments, merchantSettlementReadiness: settlementReady, driverEligibility: driverEligible })
  })

  afterEach(async () => {
    await app.close()
    await deleteTestOrders(pool, createdOrderIds.splice(0))
  })

  it('creates an order inside the merchant zone', async () => {
    const order = await createValidOrder()

    expect(order.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(order.version).toBe(1)
    expect(order).toMatchObject({ orderDetails: 'Deux sacs', deliveryInstructions: 'Sonnez', deliveryAddressComplement: 'Bâtiment B' })
    expect(typeof order.pickupScheduledAt).toBe('string')
    expect(order.cashOnDelivery).toEqual({ required: false, amountCents: null, currency: null, collected: false })
  })

  it('creates a COD order, persists cents and returns COD in merchant and driver DTOs', async () => {
    const order = await createValidOrder({ mode: 'asap' }, { amountCents: 5000 })
    expect(order.cashOnDelivery).toEqual({ required: true, amountCents: 5000, currency: 'eur', collected: false })
    await expect(pool.query<{ cash_on_delivery_amount_cents: number }>(
      'select cash_on_delivery_amount_cents from orders where id = $1', [order.id]
    )).resolves.toMatchObject({ rows: [{ cash_on_delivery_amount_cents: 5000 }] })
    await expect(pool.query<{ payload: { cashOnDeliveryRequired: boolean; cashOnDeliveryAmountCents: number } }>(
      "select payload from outbox_event where aggregate_id = $1 and event_type = 'order.created.v1'", [order.id]
    )).resolves.toMatchObject({ rows: [{ payload: { cashOnDeliveryRequired: true, cashOnDeliveryAmountCents: 5000 } }] })

    await app.inject({
      method: 'POST', url: '/api/v1/drivers/availability', headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { available: true, lat: 46.2058, lng: 5.2255 }
    })
    const available = await app.inject({
      method: 'GET', url: `/api/v1/orders/available?zoneId=${zoneId}`, headers: { authorization: `Bearer ${driverAccessToken}` }
    })
    expect(available.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: order.id, cashOnDelivery: { required: true, amountCents: 5000, currency: 'eur', collected: false } })
    ]))

    const merchantOrders = await app.inject({
      method: 'GET', url: '/api/v1/orders/merchant', headers: { authorization: `Bearer ${merchantAccessToken}` }
    })
    expect(merchantOrders.json()).toMatchObject({ orders: expect.arrayContaining([
      expect.objectContaining({ id: order.id, cashOnDelivery: { required: true, amountCents: 5000, currency: 'eur', collected: false } })
    ]) })
  })

  it('returns COD in driver active/history DTOs but never in public tracking', async () => {
    const order = await createValidOrder({ mode: 'asap' }, { amountCents: 5000 })
    const assigned = await orders.assignOrder({
      orderId: order.id as string, driverId, expectedVersion: order.version as number, actor: { type: 'driver', id: driverId }
    })
    const collected = await app.inject({
      method: 'POST', url: `/api/v1/orders/${order.id}/collect`, headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: assigned.version }
    })
    expect(collected.statusCode).toBe(200)
    const active = await app.inject({ method: 'GET', url: '/api/v1/orders/driver', headers: { authorization: `Bearer ${driverAccessToken}` } })
    expect(active.json()).toMatchObject({ orders: expect.arrayContaining([
      expect.objectContaining({ id: order.id, cashOnDelivery: { required: true, amountCents: 5000, currency: 'eur', collected: false } })
    ]) })

    const merchantOrders = await app.inject({ method: 'GET', url: '/api/v1/orders/merchant', headers: { authorization: `Bearer ${merchantAccessToken}` } })
    const merchantOrder = (merchantOrders.json() as { orders: Array<{ id: string; deliveryCode?: string }> }).orders.find(item => item.id === order.id)
    await pool.query('update orders set cash_on_delivery_collected_at = now() where id = $1', [order.id])
    const completed = await app.inject({
      method: 'POST', url: `/api/v1/orders/${order.id}/complete`, headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: collected.json().version, proof: { method: 'code', code: merchantOrder?.deliveryCode } }
    })
    expect(completed.statusCode).toBe(200)
    const history = await app.inject({ method: 'GET', url: '/api/v1/orders/driver/history', headers: { authorization: `Bearer ${driverAccessToken}` } })
    expect(history.json()).toMatchObject({ orders: expect.arrayContaining([
      expect.objectContaining({ id: order.id, cashOnDelivery: { required: true, amountCents: 5000, currency: 'eur', collected: true } })
    ]) })

    const trackingToken = await pool.query<{ tracking_token: string }>('select tracking_token from orders where id = $1', [order.id])
    const tracking = await app.inject({ method: 'GET', url: `/api/v1/orders/track/${trackingToken.rows[0]?.tracking_token ?? ''}` })
    expect(tracking.statusCode).toBe(200)
    expect(tracking.json()).not.toHaveProperty('cashOnDelivery')
  })

  it.each([99, 50001, 150.5, '5000', -1, {}, { amountCents: 5000, currency: 'eur' }, { amountCents: 5000, required: true }, { amountCents: 5000, collected: false }])(
    'rejects invalid COD payload %o',
    async cashOnDelivery => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${merchantAccessToken}` },
        payload: {
          merchantId, customerName: 'Client', customerPhone: '0', pickupScheduledAt: { mode: 'asap' },
          deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse', deliveryLat: 46.21, deliveryLng: 5.23,
          cashOnDelivery
        }
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'ValidationError' })
    }
  )

  describe('card payments guard on cash-on-delivery orders', () => {
    async function postOrder(target: FastifyInstance, cashOnDelivery?: unknown) {
      const response = await target.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: { authorization: `Bearer ${merchantAccessToken}` },
        payload: {
          merchantId,
          customerName: 'Client de test',
          customerPhone: '0000000000',
          pickupScheduledAt: { mode: 'asap' },
          deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
          deliveryLat: 46.21,
          deliveryLng: 5.23,
          ...(cashOnDelivery === undefined ? {} : { cashOnDelivery })
        }
      })
      if (response.statusCode === 201) {
        createdOrderIds.push((response.json() as { id: string }).id)
      }
      return response
    }

    it('refuses a COD order with 409 CardPaymentsNotReady while card_payments is not active, but not a non-COD order', async () => {
      const pending = new FakeConnectPaymentsProvider()
      pending.accountStatus = { ...pending.accountStatus, cardPayments: 'pending' }
      const guarded = await buildApp({ connectProvider: pending, merchantSettlementReadiness: settlementReady, driverEligibility: driverEligible })
      try {
        const countOrders = async (): Promise<number> => Number((await pool.query<{ count: string }>(
          'select count(*) from orders where merchant_id = $1', [merchantId]
        )).rows[0]?.count)
        const before = await countOrders()
        const refused = await postOrder(guarded, { amountCents: 5000 })
        expect(refused.statusCode).toBe(409)
        expect(refused.json()).toMatchObject({ error: 'CardPaymentsNotReady' })
        expect(await countOrders()).toBe(before)
        const plain = await postOrder(guarded)
        expect(plain.statusCode).toBe(201)
        expect(await countOrders()).toBe(before + 1)
      } finally {
        await guarded.close()
      }
    })

    it('refuses a COD order when the merchant has no Stripe Account or Stripe is unavailable (fail closed)', async () => {
      const unavailable = await buildApp({ merchantSettlementReadiness: settlementReady, driverEligibility: driverEligible })
      try {
        const response = await postOrder(unavailable, { amountCents: 5000 })
        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({ error: 'CardPaymentsNotReady' })
      } finally {
        await unavailable.close()
      }
    })

    it.each([
      ['sepa_not_configured', 'no active SEPA mandate'],
      ['legal_information_incomplete', 'incomplete legal information']
    ] as const)('refuses ANY order with 409 MerchantPaymentSetupIncomplete when %s (%s) and creates nothing (D-D)', async (reason, _description) => {
      const blocked = await buildApp({ connectProvider: activeCardPayments, merchantSettlementReadiness: { check: async () => ({ ready: false, reason }) } })
      try {
        const countOrders = async (): Promise<number> => Number((await pool.query<{ count: string }>('select count(*) from orders where merchant_id = $1', [merchantId])).rows[0]?.count)
        const before = await countOrders()
        const refused = await postOrder(blocked)
        expect(refused.statusCode).toBe(409)
        expect(refused.json()).toMatchObject({ error: 'MerchantPaymentSetupIncomplete' })
        expect(await countOrders()).toBe(before)
      } finally {
        await blocked.close()
      }
    })

    it('allows a COD order once card_payments is active', async () => {
      const response = await postOrder(app, { amountCents: 5000 })
      expect(response.statusCode).toBe(201)
      // La garde relit Stripe puis met le statut dérivé en cache (aucune donnée d'identité).
      await expect(pool.query(
        'select card_payments_status, requirements_count, merchant_configured_at is not null as configured from merchant_stripe_connect where merchant_id = $1',
        [merchantId]
      )).resolves.toMatchObject({ rows: [{ card_payments_status: 'active', requirements_count: 0, configured: true }] })
    })
  })

  it('accepts delayed and explicitly scheduled pickups', async () => {
    const delayed = await createValidOrder({ mode: 'delay', delayMinutes: 45 })
    const scheduled = await createValidOrder({ mode: 'scheduled', at: '2030-01-01T12:00:00+01:00' })
    expect(delayed.pickupScheduledAt).toEqual(expect.any(String))
    expect(scheduled.pickupScheduledAt).toBe('2030-01-01T11:00:00.000Z')
  })

  it.each([
    { mode: 'delay', delayMinutes: 1.5 },
    { mode: 'delay', delayMinutes: 0 },
    { mode: 'delay', delayMinutes: 121 },
    { mode: 'scheduled', at: '2030-01-01T12:00:00' }
  ])('rejects invalid pickup schedule %o', async (pickupScheduledAt) => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: { merchantId, customerName: 'Client', customerPhone: '0', deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse', deliveryLat: 46.21, deliveryLng: 5.23, pickupScheduledAt }
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects a pickup timestamp in the past', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/orders', headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: { merchantId, customerName: 'Client', customerPhone: '0', deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse', deliveryLat: 46.21, deliveryLng: 5.23, pickupScheduledAt: { mode: 'scheduled', at: '2020-01-01T12:00:00+01:00' } }
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'PastPickupScheduleError' })
  })

  it('rejects an invalid create-order payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: {
      merchantId,
      customerName: 'Client de test',
      customerPhone: '0000000000',
      pickupScheduledAt: { mode: 'asap' },
      deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
        deliveryLat: 91,
        deliveryLng: 5.23
      }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'ValidationError' })
  })

  it('rejects a delivery point outside the merchant zone before routing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: {
      merchantId,
      customerName: 'Client de test',
      customerPhone: '0000000000',
      pickupScheduledAt: { mode: 'asap' },
      deliveryAddress: 'Place Bellecour, 69002 Lyon',
        deliveryLat: 45.764,
        deliveryLng: 4.8357
      }
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'DeliveryOutsideZoneError' })
  })

  it('rejects an attempt to create an order for another merchant', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: {
      merchantId: randomUUID(),
      customerName: 'Client de test',
      customerPhone: '0000000000',
      pickupScheduledAt: { mode: 'asap' },
      deliveryAddress: '10 Avenue Alsace-Lorraine, 01000 Bourg-en-Bresse',
        deliveryLat: 46.21,
        deliveryLng: 5.23
      }
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'ForbiddenError' })
  })

  it('lists a freshly created available order in its zone', async () => {
    const order = await createValidOrder()
    // GET /orders/available ne renvoie une commande que si le livreur
    // appelant s'est déclaré disponible (clé Valkey driver:{id}:is_available) —
    // le toggle de disponibilité doit précéder l'appel.
    await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/availability',
      headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { available: true, lat: 46.2058, lng: 5.2255 }
    })
    // GET /orders/available est réservé aux livreurs de la zone demandée
    // (voir le correctif d'autorisation étape 10) — un token commerçant y
    // était accepté par erreur avant ce correctif, ce test utilisait
    // merchantAccessToken par oubli plutôt que par intention.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/orders/available?zoneId=${zoneId}`,
      headers: { authorization: `Bearer ${driverAccessToken}` }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: order.id,
          merchantName: expect.any(String),
          merchantPhone: '04 74 00 00 00',
          customerName: null,
          customerPhone: null
        })
      ])
    )
  })

  it('returns driver, details and proof data to the owning merchant', async () => {
    const order = await createValidOrder({ mode: 'scheduled', at: '2030-01-01T12:00:00+01:00' })
    const assigned = await orders.assignOrder({
      orderId: order.id as string,
      driverId,
      expectedVersion: order.version as number,
      actor: { type: 'driver', id: driverId }
    })
    const collected = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/collect`,
      headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: assigned.version }
    })
    expect(collected.statusCode).toBe(200)
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/complete`,
      headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: collected.json().version, proof: { method: 'photo', imageBase64: '/9j/2Q==' } }
    })
    expect(completed.statusCode).toBe(200)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/merchant',
      headers: { authorization: `Bearer ${merchantAccessToken}` }
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { orders: unknown[] }
    expect(body.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: order.id,
        trackingToken: expect.any(String),
        driverName: 'Jean-Paul',
        driverPhone: null,
        pickupScheduledAt: '2030-01-01T11:00:00.000Z',
        orderDetails: 'Deux sacs',
        deliveryInstructions: 'Sonnez',
        deliveryAddressComplement: 'Bâtiment B',
        deliveryProofMethod: 'photo',
        proofAsset: expect.objectContaining({
          kind: 'photo',
          contentBase64: '/9j/2Q==',
          contentType: 'image/jpeg'
        })
      })
    ]))
  })

  it('returns 404 for an unknown route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { authorization: `Bearer ${merchantAccessToken}` }
    })

    expect(response.statusCode).toBe(404)
  })
})
