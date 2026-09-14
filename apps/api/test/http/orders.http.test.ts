import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getDriverAccessToken } from '../support/get-driver-access-token.js'
import { getMerchantAccessToken } from '../support/get-merchant-access-token.js'

const zoneId = '11111111-1111-1111-1111-111111111111'
const merchantId = '22222222-2222-2222-2222-222222222222'

let app: FastifyInstance
let merchantAccessToken: string
let driverAccessToken: string

async function createValidOrder(pickupScheduledAt: unknown = { mode: 'asap' }): Promise<Record<string, unknown>> {
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
      deliveryLng: 5.23
    }
  })

  expect(response.statusCode).toBe(201)
  return response.json() as Record<string, unknown>
}

describe('orders HTTP endpoints', () => {
  beforeAll(async () => {
    merchantAccessToken = await getMerchantAccessToken()
    driverAccessToken = await getDriverAccessToken()
  })

  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('creates an order inside the merchant zone', async () => {
    const order = await createValidOrder()

    expect(order.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(order.version).toBe(1)
    expect(order).toMatchObject({ orderDetails: 'Deux sacs', deliveryInstructions: 'Sonnez', deliveryAddressComplement: 'Bâtiment B' })
    expect(typeof order.pickupScheduledAt).toBe('string')
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

  it('returns 404 when the merchant does not exist', async () => {
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

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'MerchantNotFoundError' })
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
      payload: { available: true }
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
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/assign`,
      headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: order.version }
    })
    expect(assigned.statusCode).toBe(200)
    const collected = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/collect`,
      headers: { authorization: `Bearer ${driverAccessToken}` },
      payload: { expectedVersion: assigned.json().version }
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

  it('rejects driver transitions performed by a merchant', async () => {
    const order = await createValidOrder()
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${order.id}/assign`,
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: { expectedVersion: order.version }
    })

    expect(response.statusCode).toBe(403)
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
