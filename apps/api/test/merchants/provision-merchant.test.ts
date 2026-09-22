import { describe, expect, it, vi } from 'vitest'
import { ProvisionMerchantUseCase } from '../../src/modules/merchants/application/provision-merchant.js'
import { MerchantProvisioningError } from '../../src/modules/merchants/domain/errors.js'
import type { MerchantRepository } from '../../src/modules/merchants/ports/merchant-repository.js'
import type { AuthAdmin } from '../../src/modules/auth/public.js'
import { PostgresMerchantRepository } from '../../src/modules/merchants/infrastructure/postgres-merchant-repository.js'

describe('ProvisionMerchantUseCase', () => {
  it('inserts every deferred onboarding field as null inside a local transaction', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push(values === undefined ? { sql } : { sql, values })
        return { rows: [] }
      }),
      release: vi.fn()
    }
    const repository = new PostgresMerchantRepository({ connect: vi.fn(async () => client) } as never)
    await repository.createIncomplete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'New shop')
    expect(queries.map(({ sql }) => sql)).toEqual(['BEGIN', expect.stringContaining('insert into merchants'), 'COMMIT'])
    expect(queries[1]?.values).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'New shop'])
    expect(queries[1]?.sql).toContain('onboarding_completed, zone_id, address, lat, lng, phone_primary, phone_secondary, logo_url')
    expect(queries[1]?.sql).toContain('false, null, null, null, null, null, null, null')
  })
  it('creates the auth user before inserting an incomplete merchant profile', async () => {
    const calls: string[] = []
    const auth: AuthAdmin = {
      createUser: vi.fn(async () => { calls.push('auth') }),
      deleteUser: vi.fn()
    }
    const repository = { createIncomplete: vi.fn(async () => { calls.push('transaction') }) } as unknown as MerchantRepository
    const useCase = new ProvisionMerchantUseCase(repository, auth)

    const result = await useCase.execute({ merchantName: 'New shop', email: 'shop@example.test', password: 'password1', correlationId: 'corr-1', logger: { error: vi.fn() } })

    expect(result).toMatchObject({ merchantId: expect.any(String), onboardingCompleted: false })
    expect(calls).toEqual(['auth', 'transaction'])
    expect(auth.createUser).toHaveBeenCalledWith(expect.objectContaining({ id: result.merchantId, email: 'shop@example.test', appMetadata: { role: 'merchant' } }))
    expect(repository.createIncomplete).toHaveBeenCalledWith(result.merchantId, 'New shop')
  })

  it('compensates the auth user and logs an orphan if compensation fails', async () => {
    const deleteUser = vi.fn(async () => { throw new Error('delete failed') })
    const logger = { error: vi.fn() }
    const auth: AuthAdmin = { createUser: vi.fn(), deleteUser }
    const repository = { createIncomplete: vi.fn(async () => { throw new Error('insert failed') }) } as unknown as MerchantRepository
    const useCase = new ProvisionMerchantUseCase(repository, auth)

    await expect(useCase.execute({ merchantName: 'New shop', email: 'shop@example.test', password: 'password1', correlationId: 'corr-2', logger })).rejects.toBeInstanceOf(MerchantProvisioningError)
    const authUserId = (deleteUser.mock.calls[0] as [string] | undefined)?.[0]
    expect(authUserId).toMatch(/^[0-9a-f-]{36}$/)
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-2', authUserId }), expect.any(String))
  })
})
