import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerOrderHttpRoutes } from '../../src/modules/orders/transport/http/routes.js'
import { CreateOrderUseCase } from '../../src/modules/orders/application/create-order.js'
import { EstimateOrderUseCase } from '../../src/modules/orders/application/estimate-order.js'

const merchant = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'New shop', zoneId: null, address: null, phonePrimary: null, phoneSecondary: null, logoUrl: null, lat: null, lng: null, onboardingCompleted: false }

async function buildApp() {
  const app = Fastify()
  app.decorateRequest('correlationId', '')
  app.decorateRequest('authUser')
  app.addHook('onRequest', async (request) => {
    request.correlationId = 'onboarding-correlation'
    request.authUser = { id: merchant.id, role: 'merchant' }
  })
  const createOrder = new CreateOrderUseCase({ create: async () => { throw new Error('must not persist') } } as never, { getRoute: async () => { throw new Error('must not route') } } as never, { now: () => new Date() })
  const estimateOrder = new EstimateOrderUseCase({ geocode: async () => { throw new Error('must not geocode') } } as never, { getRoute: async () => { throw new Error('must not route') } } as never)
  await app.register(registerOrderHttpRoutes, {
    orders: { createOrder: createOrder.execute.bind(createOrder), estimateOrder: estimateOrder.execute.bind(estimateOrder) },
    findMerchantById: async () => merchant,
    findZoneById: async () => null,
    findDriverById: async () => null
  } as never)
  return app
}

describe('merchant onboarding order gate', () => {
  it('returns a clean 422 rather than 500 for estimates', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/api/v1/orders/estimate?deliveryAddress=Somewhere' })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'MerchantOnboardingIncompleteError' })
    await app.close()
  })

  it('returns a clean 422 rather than 500 for order creation', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'POST', url: '/api/v1/orders', payload: { merchantId: merchant.id, customerName: 'Customer', customerPhone: '0', pickupScheduledAt: { mode: 'asap' }, deliveryAddress: 'Somewhere', deliveryLat: 0, deliveryLng: 0 } })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'MerchantOnboardingIncompleteError' })
    await app.close()
  })
})
