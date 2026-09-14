import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getMerchantAccessToken } from '../support/get-merchant-access-token.js'

let app: FastifyInstance
let merchantAccessToken: string

function estimateUrl(deliveryAddress: string): string {
  return `/api/v1/orders/estimate?deliveryAddress=${encodeURIComponent(deliveryAddress)}`
}

describe('GET /api/v1/orders/estimate', () => {
  beforeAll(async () => {
    merchantAccessToken = await getMerchantAccessToken()
  })

  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns a delivery estimate for an address inside the merchant zone', async () => {
    const response = await app.inject({
      method: 'GET',
      url: estimateUrl('Place de la Grenette, 01000 Bourg-en-Bresse'),
      headers: { authorization: `Bearer ${merchantAccessToken}` }
    })

    expect(response.statusCode).toBe(200)
    const estimate = response.json() as Record<string, unknown>
    expect(estimate.distanceM).toSatisfy((value: unknown) => typeof value === 'number' && value > 0)
    expect(estimate.durationS).toSatisfy((value: unknown) => typeof value === 'number' && value > 0)
    expect(estimate.priceCents).toSatisfy(
      (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 400
    )
    expect(estimate.deliveryLat).toSatisfy((value: unknown) => typeof value === 'number' && Number.isFinite(value))
    expect(estimate.deliveryLng).toSatisfy((value: unknown) => typeof value === 'number' && Number.isFinite(value))
    expect(estimate.geometry).toMatchObject({ type: 'LineString' })
    expect((estimate.geometry as { coordinates: unknown[] }).coordinates).toSatisfy(
      (coordinates: unknown[]) => coordinates.length >= 2 && coordinates.every((point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === 'number'))
    )
  })

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: estimateUrl('Place de la Grenette, 01000 Bourg-en-Bresse')
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a geocoded address outside the merchant zone', async () => {
    const response = await app.inject({
      method: 'GET',
      url: estimateUrl('Place de la Concorde, 75008 Paris'),
      headers: { authorization: `Bearer ${merchantAccessToken}` }
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'DeliveryOutsideZoneError' })
  })
})
