import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getMerchantAccessToken } from '../support/get-merchant-access-token.js'

const seedMerchant = {
  name: 'Restaurant Le Terminus',
  phonePrimary: '04 74 00 00 00',
  phoneSecondary: null,
  logoUrl: null,
  address: 'Place de la Grenette, 01000 Bourg-en-Bresse',
  lat: 46.2058,
  lng: 5.2255,
  zoneId: '11111111-1111-1111-1111-111111111111',
  merchantInformationCompleted: true,
  onboardingCompleted: true
}

const { onboardingCompleted: _seedOnboardingCompleted, ...seedMerchantPatch } = seedMerchant

let app: FastifyInstance
let merchantAccessToken: string

describe('merchants HTTP endpoints', () => {
  beforeAll(async () => {
    merchantAccessToken = await getMerchantAccessToken()
  })

  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns the authenticated merchant profile', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/merchants/me',
      headers: { authorization: `Bearer ${merchantAccessToken}` }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(seedMerchant)
  })

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/merchants/me' })

    expect(response.statusCode).toBe(401)
  })

  it('rejects client-supplied coordinates rather than trusting them', async () => {
    const headers = { authorization: `Bearer ${merchantAccessToken}` }
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/merchants/me', headers, payload: { name: 'Test', address: 'Test', phonePrimary: '04 74 11 22 33', lat: 0 } })
    expect(response.statusCode).toBe(400)
  })

  it('requires a primary phone number', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/merchants/me',
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: { name: 'Test', address: 'Test' }
    })

    expect(response.statusCode).toBe(400)
  })
})
