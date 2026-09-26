import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { registerDriverHttpRoutes } from '../../src/modules/drivers/public.js'
import { DriverSignupConflictError } from '../../src/modules/drivers/domain/driver-signup-errors.js'

const valid = { firstName: ' Ada ', lastName: ' Lovelace ', email: ' ADA@EXAMPLE.TEST ', phone: '06 12 34 56 78', password: 'Strong!Pass1', termsAccepted: true }
async function build(provisionDriver = vi.fn(async () => ({ driverId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))) {
  const app = Fastify(); app.decorateRequest('correlationId', ''); app.addHook('onRequest', async (request) => { request.correlationId = 'signup-correlation' })
  await app.register(registerDriverHttpRoutes, { drivers: { provisionDriver } } as never); return { app, provisionDriver }
}
describe('driver signup HTTP endpoint', () => {
  it('normalizes a valid public signup and assigns no client role', async () => {
    const { app, provisionDriver } = await build(); const response = await app.inject({ method: 'POST', url: '/api/v1/auth/driver-signup', payload: valid })
    expect(response.statusCode).toBe(201); expect(provisionDriver).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: '+33612345678' })); await app.close()
  })
  it.each([{ ...valid, termsAccepted: false }, { ...valid, termsAccepted: undefined }, { ...valid, password: 'weakpass' }, { ...valid, phone: '+44 20 1234 5678' }, { ...valid, role: 'merchant' }, { ...valid, passwordConfirmation: 'Strong!Pass1' }])('rejects invalid, role-bearing, or unexpected-field input', async (payload) => { const { app } = await build(); expect((await app.inject({ method: 'POST', url: '/api/v1/auth/driver-signup', payload })).statusCode).toBe(400); await app.close() })
  it('maps all duplicate identity collisions to generic 409', async () => { const { app } = await build(vi.fn(async () => { throw new DriverSignupConflictError() })); const response = await app.inject({ method: 'POST', url: '/api/v1/auth/driver-signup', payload: valid }); expect(response.statusCode).toBe(409); expect(response.json()).toMatchObject({ error: 'AccountAlreadyExistsError' }); await app.close() })
})
