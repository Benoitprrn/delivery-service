import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDriverHttpRoutes } from '../../src/modules/drivers/transport/http/routes.js'
import { registerOrderHttpRoutes } from '../../src/modules/orders/transport/http/routes.js'

const authenticatedDriverId = '33333333-3333-3333-3333-333333333333'
const otherDriverId = '44444444-4444-4444-4444-444444444444'
const orderId = '55555555-5555-5555-5555-555555555555'
const correlationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

let app: FastifyInstance
let authUser: { id: string; role: 'merchant' | 'driver' | 'admin' }

describe('driver HTTP authorization and identity scoping', () => {
  beforeEach(async () => {
    app = Fastify()
    authUser = { id: authenticatedDriverId, role: 'driver' }
    app.addHook('onRequest', async (request) => {
      request.correlationId = correlationId
      request.authUser = authUser
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('records location only for the authenticated driver and validates coordinates', async () => {
    const recordLocation = vi.fn().mockResolvedValue(undefined)
    await app.register(registerDriverHttpRoutes, {
      drivers: { findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(), recordLocation, setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: vi.fn() }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      payload: { lat: 46.2058, lng: 5.2255, recordedAt: '2026-09-12T10:30:00.000Z' }
    })
    expect(response.statusCode).toBe(204)
    expect(recordLocation).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: authenticatedDriverId, lat: 46.2058, lng: 5.2255 })
    )

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      payload: { lat: 91, lng: 5.2255, recordedAt: '2026-09-12T10:30:00.000Z' }
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('ignores the legacy optional position when setting availability and returns the Valkey state', async () => {
    const setAvailability = vi.fn().mockResolvedValue({ available: true })
    const isAvailable = vi.fn().mockResolvedValue(true)
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(),
        recordLocation: vi.fn(), setAvailability, disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable, getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/availability',
      payload: { available: true, lat: 46.2058, lng: 5.2255 }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ available: true })
    expect(setAvailability).toHaveBeenCalledWith(authenticatedDriverId, true)
    expect(isAvailable).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('accepts becoming available without coordinates', async () => {
    const setAvailability = vi.fn()
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(),
        recordLocation: vi.fn(), setAvailability, disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', payload: { available: true } })
    expect(response.statusCode).toBe(200)
    expect(setAvailability).toHaveBeenCalledWith(authenticatedDriverId, true)
  })

  it('registers a push token for the authenticated driver only', async () => {
    const registerPushToken = vi.fn().mockResolvedValue(undefined)
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken,
        recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/push-token',
      payload: { token: 'ExponentPushToken[test-token]' }
    })

    expect(response.statusCode).toBe(204)
    expect(registerPushToken).toHaveBeenCalledWith(authenticatedDriverId, 'ExponentPushToken[test-token]')

    const invalid = await app.inject({ method: 'POST', url: '/api/v1/drivers/push-token', payload: { token: '' } })
    expect(invalid.statusCode).toBe(400)
  })

  it('accepts an empty JSON body for a driver heartbeat', async () => {
    const heartbeat = vi.fn().mockResolvedValue(undefined)
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(),
        recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat, isAvailable: vi.fn(), getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/heartbeat',
      payload: {}
    })

    expect(response.statusCode).toBe(204)
    expect(heartbeat).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('disconnects the authenticated driver', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(),
        recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect, heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/me/disconnect', payload: {} })

    expect(response.statusCode).toBe(204)
    expect(disconnect).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('forbids non-drivers from registering a push token', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const registerPushToken = vi.fn()
    await app.register(registerDriverHttpRoutes, {
      drivers: {
        findDriverById: vi.fn(), findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken,
        recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: vi.fn()
      }
    })

    const response = await app.inject({ method: 'POST', url: '/api/v1/drivers/push-token', payload: { token: 'ExponentPushToken[test-token]' } })

    expect(response.statusCode).toBe(403)
    expect(registerPushToken).not.toHaveBeenCalled()
  })

  it('returns the authenticated driver profile', async () => {
    const driver = {
      id: authenticatedDriverId,
      name: 'Jean-Paul',
      zoneId: '11111111-1111-1111-1111-111111111111',
      isAvailable: true
    }
    const findDriverById = vi.fn().mockResolvedValue(driver)
    await app.register(registerDriverHttpRoutes, {
      drivers: { findDriverById, findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(), recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: findDriverById }
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(driver)
    expect(findDriverById).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('forbids non-driver access to the driver profile', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const findDriverById = vi.fn()
    await app.register(registerDriverHttpRoutes, {
      drivers: { findDriverById, findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(), recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: findDriverById }
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me' })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: 'ForbiddenError',
      message: 'Only drivers can access this resource',
      correlationId
    })
    expect(findDriverById).not.toHaveBeenCalled()
  })

  it('returns 404 when the authenticated driver has no profile', async () => {
    const findDriverById = vi.fn().mockResolvedValue(null)
    await app.register(registerDriverHttpRoutes, {
      drivers: { findDriverById, findDriverIdsByZoneId: vi.fn(), findPushTokensByDriverIds: vi.fn(), registerPushToken: vi.fn(), recordLocation: vi.fn(), setAvailability: vi.fn(), disconnect: vi.fn(), heartbeat: vi.fn(), isAvailable: vi.fn(), getLiveDriverProfile: findDriverById }
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'DriverNotFoundError',
      message: 'Driver profile was not found',
      correlationId
    })
  })

  it('scopes my courses to the authenticated driver', async () => {
    const getDriverOrders = vi.fn().mockResolvedValue([{
      id: orderId,
      status: 'ASSIGNED',
      merchantName: 'Restaurant Le Terminus',
      merchantPhone: '04 74 00 00 00',
      customerName: null,
      customerPhone: null,
      pickupScheduledAt: new Date('2030-01-01T11:00:00.000Z'),
      orderDetails: 'Two bags',
      deliveryInstructions: 'Ring',
      deliveryAddressComplement: 'Building B'
    }])
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(),
        collectOrder: vi.fn(),
        completeOrder: vi.fn(),
        returnOrder: vi.fn(),
        confirmReturn: vi.fn(),
        createOrder: vi.fn(),
        estimateOrder: vi.fn(),
        getMerchantOrders: vi.fn(),
        getDriverOrders,
        getDriverHistory: vi.fn(),
        getDriverEarnings: vi.fn(),
        listAvailableOrders: vi.fn(), getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(),
      findZoneById: vi.fn(),
      findDriverById: vi.fn()
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/driver' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ orders: [{
      id: orderId,
      status: 'ASSIGNED',
      merchantName: 'Restaurant Le Terminus',
      merchantPhone: '04 74 00 00 00',
      customerName: null,
      customerPhone: null,
      pickupScheduledAt: '2030-01-01T11:00:00.000Z',
      orderDetails: 'Two bags',
      deliveryInstructions: 'Ring',
      deliveryAddressComplement: 'Building B'
    }] })
    expect(getDriverOrders).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('lists history scoped to the authenticated driver', async () => {
    const getDriverHistory = vi.fn().mockResolvedValue([{
      id: orderId,
      status: 'COMPLETED',
      completedAt: new Date('2026-09-14T12:00:00.000Z'),
      driverEarningCents: 850
    }])
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory, getDriverEarnings: vi.fn(), listAvailableOrders: vi.fn(), getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/driver/history' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ orders: [{
      id: orderId,
      status: 'COMPLETED',
      completedAt: '2026-09-14T12:00:00.000Z',
      driverEarningCents: 850
    }] })
    expect(getDriverHistory).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('forbids non-drivers from viewing history', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const getDriverHistory = vi.fn()
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory, getDriverEarnings: vi.fn(), listAvailableOrders: vi.fn(), getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/driver/history' })

    expect(response.statusCode).toBe(403)
    expect(getDriverHistory).not.toHaveBeenCalled()
  })

  it('returns earnings scoped to the authenticated driver', async () => {
    const earnings = {
      totalEarningCents: 1_230,
      completedOrderCount: 2,
      currency: 'EUR' as const,
      paymentMethod: 'bank_transfer' as const,
      paymentStatus: 'provisional' as const,
      recentCompletedOrders: []
    }
    const getDriverEarnings = vi.fn().mockResolvedValue(earnings)
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory: vi.fn(), getDriverEarnings, listAvailableOrders: vi.fn(), getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
    })

    const forged = await app.inject({ method: 'GET', url: `/api/v1/orders/driver/earnings?driverId=${otherDriverId}` })
    expect(forged.statusCode).toBe(400)
    expect(getDriverEarnings).not.toHaveBeenCalled()

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/driver/earnings' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(earnings)
    expect(getDriverEarnings).toHaveBeenCalledWith(authenticatedDriverId)
  })

  it('forbids non-drivers from viewing earnings', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const getDriverEarnings = vi.fn()
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory: vi.fn(), getDriverEarnings, listAvailableOrders: vi.fn(), getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById: vi.fn()
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/driver/earnings' })

    expect(response.statusCode).toBe(403)
    expect(getDriverEarnings).not.toHaveBeenCalled()
  })

  it('forbids non-drivers from listing available orders', async () => {
    authUser = { id: '22222222-2222-2222-2222-222222222222', role: 'merchant' }
    const listAvailableOrders = vi.fn()
    const findDriverById = vi.fn()
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory: vi.fn(), getDriverEarnings: vi.fn(), listAvailableOrders, getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/available?zoneId=11111111-1111-1111-1111-111111111111' })

    expect(response.statusCode).toBe(403)
    expect(listAvailableOrders).not.toHaveBeenCalled()
    expect(findDriverById).not.toHaveBeenCalled()
  })

  it('forbids a driver from listing available orders outside their zone', async () => {
    const listAvailableOrders = vi.fn()
    const findDriverById = vi.fn().mockResolvedValue({
      id: authenticatedDriverId,
      name: 'Jean-Paul',
      zoneId: '11111111-1111-1111-1111-111111111111',
      isAvailable: true
    })
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory: vi.fn(), getDriverEarnings: vi.fn(), listAvailableOrders, getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(), findZoneById: vi.fn(), findDriverById
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/available?zoneId=22222222-2222-2222-2222-222222222222' })

    expect(response.statusCode).toBe(403)
    expect(listAvailableOrders).not.toHaveBeenCalled()
  })

  it('lists available orders for a driver in their own zone', async () => {
    const availableOrders = [{ id: orderId, status: 'AVAILABLE' }]
    const listAvailableOrders = vi.fn().mockResolvedValue(availableOrders)
    const zoneId = '11111111-1111-1111-1111-111111111111'
    await app.register(registerOrderHttpRoutes, {
      orders: {
        assignOrder: vi.fn(), collectOrder: vi.fn(), completeOrder: vi.fn(), returnOrder: vi.fn(), confirmReturn: vi.fn(),
        createOrder: vi.fn(), estimateOrder: vi.fn(), getMerchantOrders: vi.fn(), getDriverOrders: vi.fn(), getDriverHistory: vi.fn(), getDriverEarnings: vi.fn(), listAvailableOrders, getOrderRoute: vi.fn(), findDriverOrderById: vi.fn()
      },
      findMerchantById: vi.fn(),
      findZoneById: vi.fn(),
      findDriverById: vi.fn().mockResolvedValue({ id: authenticatedDriverId, name: 'Jean-Paul', zoneId, isAvailable: true })
    })

    const response = await app.inject({ method: 'GET', url: `/api/v1/orders/available?zoneId=${zoneId}` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(availableOrders)
    expect(listAvailableOrders).toHaveBeenCalledWith({ driverId: authenticatedDriverId, zoneId })
  })
})
