import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { getMerchantAccessToken } from '../support/get-merchant-access-token.js'

const seedMerchant = {
  name: 'Restaurant Le Terminus',
  phoneLandline: '04 74 00 00 00',
  phoneMobile: null,
  logoUrl: null,
  address: 'Place de la Grenette, 01000 Bourg-en-Bresse',
  lat: 46.2058,
  lng: 5.2255
}

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

  it('updates and restores the authenticated merchant profile with a landline only', async () => {
    const updatedMerchant = {
      name: 'Restaurant Le Terminus Test',
      phoneLandline: '04 74 11 22 33',
      phoneMobile: null,
      logoUrl: null,
      address: '1 Rue du Test, 01000 Bourg-en-Bresse',
      lat: 46.21,
      lng: 5.23
    }
    const headers = { authorization: `Bearer ${merchantAccessToken}` }

    try {
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/api/v1/merchants/me',
        headers,
        payload: updatedMerchant
      })
      expect(updateResponse.statusCode).toBe(200)
      expect(updateResponse.json()).toEqual(updatedMerchant)
    } finally {
      const restoreResponse = await app.inject({
        method: 'PATCH',
        url: '/api/v1/merchants/me',
        headers,
        payload: seedMerchant
      })
      expect(restoreResponse.statusCode).toBe(200)
      expect(restoreResponse.json()).toEqual(seedMerchant)
    }
  })

  it('accepts a mobile phone without a landline', async () => {
    const headers = { authorization: `Bearer ${merchantAccessToken}` }
    const mobileOnlyMerchant = { ...seedMerchant, phoneLandline: null, phoneMobile: '06 12 34 56 78' }

    try {
      const response = await app.inject({ method: 'PATCH', url: '/api/v1/merchants/me', headers, payload: mobileOnlyMerchant })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(mobileOnlyMerchant)
    } finally {
      await app.inject({ method: 'PATCH', url: '/api/v1/merchants/me', headers, payload: seedMerchant })
    }
  })

  it('rejects an update without a landline or mobile phone', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/merchants/me',
      headers: { authorization: `Bearer ${merchantAccessToken}` },
      payload: { ...seedMerchant, phoneLandline: null, phoneMobile: null }
    })

    expect(response.statusCode).toBe(422)
  })
})
