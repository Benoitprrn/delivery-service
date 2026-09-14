import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'

let app: FastifyInstance

describe('authentication', () => {
  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects an API request without an Authorization header', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/orders' })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an unauthenticated driver profile request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me' })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an API request with an invalid bearer token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { authorization: 'Bearer not-a-real-jwt' }
    })

    expect(response.statusCode).toBe(401)
  })

  it('keeps the health endpoint public', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
  })
})
