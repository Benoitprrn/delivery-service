import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerMerchantHttpRoutes } from '../../src/modules/merchants/public.js'
import { AccountAlreadyExistsError } from '../../src/modules/auth/domain/auth-admin-errors.js'

function buildSignupApp(provisionMerchant = vi.fn(async () => ({ merchantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', onboardingCompleted: false as const }))) {
  const app = Fastify()
  app.decorateRequest('correlationId', '')
  app.addHook('onRequest', async (request) => { request.correlationId = 'signup-correlation' })
  return app.register(registerMerchantHttpRoutes, { merchants: { provisionMerchant } } as never).then(() => ({ app, provisionMerchant }))
}

describe('merchant signup HTTP endpoint', () => {
  it('accepts a valid public signup', async () => {
    const { app, provisionMerchant } = await buildSignupApp()
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/merchant-signup', payload: { merchantName: '  My Shop ', email: ' SHOP@EXAMPLE.TEST ', password: 'password1', passwordConfirmation: 'password1' } })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ merchantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', onboardingCompleted: false })
    expect(provisionMerchant).toHaveBeenCalledWith(expect.objectContaining({ merchantName: 'My Shop', email: 'shop@example.test', password: 'password1' }))
    await app.close()
  })

  it.each([
    { email: 'nope', password: 'password1', passwordConfirmation: 'password1' },
    { email: 'shop@example.test', password: 'short', passwordConfirmation: 'short' },
    { email: 'shop@example.test', password: 'password1', passwordConfirmation: 'password2' }
  ])('rejects invalid signup input', async (payload) => {
    const { app } = await buildSignupApp()
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/merchant-signup', payload: { merchantName: 'Shop', ...payload } })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'ValidationError' })
    await app.close()
  })

  it('maps duplicate accounts to 409', async () => {
    const { app } = await buildSignupApp(vi.fn(async () => { throw new AccountAlreadyExistsError() }))
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/merchant-signup', payload: { merchantName: 'Shop', email: 'shop@example.test', password: 'password1', passwordConfirmation: 'password1' } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'AccountAlreadyExistsError' })
    await app.close()
  })
})
