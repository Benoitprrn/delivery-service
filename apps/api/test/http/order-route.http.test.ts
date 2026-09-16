import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { OrderNotFoundError } from '../../src/modules/orders/domain/errors.js'
import { registerOrderHttpRoutes } from '../../src/modules/orders/transport/http/routes.js'

const driverId = '33333333-3333-3333-3333-333333333333'
const orderId = '55555555-5555-5555-5555-555555555555'
const zoneId = '11111111-1111-1111-1111-111111111111'
const correlationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

let app: FastifyInstance
let authUser: { id: string; role: 'merchant' | 'driver' | 'admin' }

function orders(getOrderRoute = vi.fn()) {
  return {
    createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(),
    getDriverHistory: vi.fn(), getDriverEarnings: vi.fn(), listAvailableOrders: vi.fn(),
    assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
    findDriverOrderById: vi.fn(),
    getOrderRoute
  }
}

describe('GET /api/v1/orders/:id/route', () => {
  beforeEach(async () => {
    app = Fastify()
    authUser = { id: driverId, role: 'driver' }
    app.addHook('onRequest', async (request) => {
      request.correlationId = correlationId
      request.authUser = authUser
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 403 for a non-driver', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const getOrderRoute = vi.fn()
    await app.register(registerOrderHttpRoutes, {
      orders: orders(getOrderRoute), findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
    })

    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/route` })

    expect(response.statusCode).toBe(403)
    expect(getOrderRoute).not.toHaveBeenCalled()
  })

  it('maps an unknown order to 404', async () => {
    const getOrderRoute = vi.fn().mockRejectedValue(new OrderNotFoundError(`Order ${orderId} not found`))
    await app.register(registerOrderHttpRoutes, {
      orders: orders(getOrderRoute), findMerchantById: vi.fn(), findZoneById: vi.fn(),
      findDriverById: vi.fn().mockResolvedValue({ id: driverId, name: 'Jean-Paul', phone: null, zoneId, isAvailable: true })
    })

    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/route` })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'OrderNotFoundError' })
  })

  it('returns a GeoJSON LineString for a driver in the order zone', async () => {
    const geometry = { type: 'LineString' as const, coordinates: [[5.2255, 46.2058], [5.23, 46.21]] as [number, number][] }
    const getOrderRoute = vi.fn().mockResolvedValue(geometry)
    await app.register(registerOrderHttpRoutes, {
      orders: orders(getOrderRoute), findMerchantById: vi.fn(), findZoneById: vi.fn(),
      findDriverById: vi.fn().mockResolvedValue({ id: driverId, name: 'Jean-Paul', phone: null, zoneId, isAvailable: true })
    })

    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/route` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ geometry })
    expect(getOrderRoute).toHaveBeenCalledWith({ orderId, driverZoneId: zoneId })
  })

  it('returns 401 without a JWT', async () => {
    const authenticatedApp = await buildApp()
    try {
      const response = await authenticatedApp.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/route` })
      expect(response.statusCode).toBe(401)
    } finally {
      await authenticatedApp.close()
    }
  })
})
