import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerOrderHttpRoutes } from '../../src/modules/orders/transport/http/routes.js'

let app: ReturnType<typeof Fastify> | undefined

afterEach(async () => { await app?.close(); app = undefined })

function routeOptions(getOrderTracking: (token: string) => Promise<unknown>) {
  return {
    orders: {
      createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(),
      getDriverHistory: vi.fn(), getDriverEarnings: vi.fn(), getOrderRoute: vi.fn(), listAvailableOrders: vi.fn(),
      assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
      getOrderTracking
    }, findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
  }
}

describe('GET /api/v1/orders/track/:token', () => {
  it('is public and exposes only the tracking contract', async () => {
    app = Fastify()
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
    await app.register(registerOrderHttpRoutes, routeOptions(async () => ({
      status: 'ASSIGNED', assignedAt: '2026-09-14T10:00:00.000Z', collectedAt: null, completedAt: null,
      estimatedDeliveryAt: '2026-09-14T10:10:00.000Z', driverPosition: { lat: 46.2, lng: 5.2 }
    })))
    const response = await app.inject('/api/v1/orders/track/11111111-1111-4111-8111-111111111111')
    expect(response.statusCode).toBe(200)
    expect(Object.keys(response.json()).sort()).toEqual([
      'assignedAt', 'collectedAt', 'completedAt', 'driverPosition', 'estimatedDeliveryAt', 'status'
    ])
    expect(JSON.stringify(response.json())).not.toMatch(/customer_|delivery_address|order_details|price_cents|driver_earning|merchant_id|driver_id|zone_id|pickup_address|delivery_code|proof/i)
  })

  it('returns the same 404 for unknown and malformed tokens', async () => {
    app = Fastify()
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
    await app.register(registerOrderHttpRoutes, routeOptions(async () => null))
    await expect(app.inject('/api/v1/orders/track/not-a-token')).resolves.toMatchObject({ statusCode: 404 })
  })

  it('uses the strict route-specific limit', async () => {
    app = Fastify()
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
    await app.register(registerOrderHttpRoutes, routeOptions(async () => null))
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await app.inject('/api/v1/orders/track/missing')).statusCode).toBe(404)
    }
    expect((await app.inject('/api/v1/orders/track/missing')).statusCode).toBe(429)
  })
})
