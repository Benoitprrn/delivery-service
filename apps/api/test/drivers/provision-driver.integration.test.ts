import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ProvisionDriverUseCase } from '../../src/modules/drivers/application/provision-driver.js'
import { PostgresDriverSignupRepository } from '../../src/modules/drivers/infrastructure/postgres-driver-signup-repository.js'
import { DriverProvisioningError, DriverSignupConflictError, DriverSignupFinalizingError } from '../../src/modules/drivers/domain/driver-signup-errors.js'
import { AccountAlreadyExistsError, AuthProviderUnknownOutcomeError, PostgresAccountPhoneRegistry } from '../../src/modules/auth/public.js'
import type { AuthAdmin, AuthUserLookup } from '../../src/modules/auth/public.js'
import { pool } from '../../src/platform/db.js'

const zoneId = '11111111-1111-1111-1111-111111111111'

// The real Supabase Auth admin is never called from tests; each test supplies a
// fake matching the exact edge case it exercises. `createdIds` doubles as the
// "does an auth user with this id exist" oracle for the lookup fake below.
function fakeAuth(overrides: Partial<AuthAdmin & AuthUserLookup> = {}): AuthAdmin & AuthUserLookup {
  return {
    createUser: async () => undefined,
    deleteUser: async () => undefined,
    getUserEmail: async () => null,
    ...overrides
  }
}

const createdDriverIds: string[] = []
async function cleanup(driverId: string): Promise<void> {
  // driver_terms_acceptances is intentionally append-only (trigger-enforced),
  // and drivers.id is referenced by it (FK, no cascade) once a signup finalizes
  // — a finalized driver row is therefore permanently undeletable, by design,
  // exactly like a real account. This file must run against a disposable
  // database (docs/work/r54-testdb.sh), never the shared dev DB.
  try { await pool.query('delete from drivers where id = $1', [driverId]) } catch { /* finalized signup: expected, see above */ }
  await pool.query('delete from account_phone_registry where account_id = $1', [driverId])
  await pool.query('delete from outbox_event where aggregate_id = $1', [driverId])
}

afterEach(async () => {
  while (createdDriverIds.length > 0) {
    const id = createdDriverIds.pop()
    if (id !== undefined) await cleanup(id)
  }
})

function buildUseCase(auth: AuthAdmin & AuthUserLookup): ProvisionDriverUseCase {
  return new ProvisionDriverUseCase(pool, new PostgresDriverSignupRepository(), new PostgresAccountPhoneRegistry(), auth, zoneId)
}

async function driverRow(driverId: string) {
  const result = await pool.query('select zone_id, is_available, first_name, last_name, phone from drivers where id = $1', [driverId])
  return result.rows[0] as { zone_id: string; is_available: boolean; first_name: string; last_name: string; phone: string } | undefined
}

describe('ProvisionDriverUseCase (real Postgres)', () => {
  it('creates the driver, reserves the phone, and records terms acceptance in one local transaction before calling Auth', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const useCase = buildUseCase(fakeAuth())
    const { driverId } = await useCase.execute({ firstName: 'Ada', lastName: 'Lovelace', email: `ada-${randomUUID()}@example.test`, phone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })
    createdDriverIds.push(driverId)

    const row = await driverRow(driverId)
    expect(row).toMatchObject({ zone_id: zoneId, is_available: false, first_name: 'Ada', last_name: 'Lovelace', phone })
    const registry = await pool.query('select role, phone_e164 from account_phone_registry where account_id = $1', [driverId])
    expect(registry.rows[0]).toEqual({ role: 'driver', phone_e164: phone })
    const terms = await pool.query('select version from driver_terms_acceptances where driver_id = $1', [driverId])
    expect(terms.rows).toHaveLength(1)
  })

  it('lets exactly one of two concurrent signups with the identical phone succeed, enforced by the DB unique constraint', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const useCaseA = buildUseCase(fakeAuth())
    const useCaseB = buildUseCase(fakeAuth())
    const command = (email: string) => ({ firstName: 'Race', lastName: 'Condition', email, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })

    const results = await Promise.allSettled([
      useCaseA.execute({ ...command(`race-a-${randomUUID()}@example.test`), phone }),
      useCaseB.execute({ ...command(`race-b-${randomUUID()}@example.test`), phone })
    ])

    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ driverId: string }> => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(DriverSignupConflictError)
    if (fulfilled[0] !== undefined) createdDriverIds.push(fulfilled[0].value.driverId)

    const registryRows = await pool.query('select account_id from account_phone_registry where phone_e164 = $1', [phone])
    expect(registryRows.rows).toHaveLength(1)
  })

  it('rejects a driver signup reusing a phone already tied to an existing merchant account', async () => {
    const merchantPhone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const merchantId = '22222222-2222-2222-2222-222222222222' // seeded merchant fixture
    await pool.query('insert into account_phone_registry (account_id, role, phone_e164) values ($1, $2, $3)', [merchantId, 'merchant', merchantPhone])
    try {
      const useCase = buildUseCase(fakeAuth())
      await expect(useCase.execute({ firstName: 'Cross', lastName: 'Role', email: `cross-${randomUUID()}@example.test`, phone: merchantPhone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })).rejects.toBeInstanceOf(DriverSignupConflictError)
      const driverRows = await pool.query('select 1 from drivers where phone = $1', [merchantPhone])
      expect(driverRows.rows).toHaveLength(0)
    } finally {
      await pool.query('delete from account_phone_registry where account_id = $1 and role = $2', [merchantId, 'merchant'])
    }
  })

  it('compensates the local reservation when Auth reports a confirmed duplicate email', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const useCase = buildUseCase(fakeAuth({ createUser: async () => { throw new AccountAlreadyExistsError() } }))
    await expect(useCase.execute({ firstName: 'Dup', lastName: 'Email', email: 'dup@example.test', phone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })).rejects.toBeInstanceOf(DriverSignupConflictError)

    const registryRows = await pool.query('select 1 from account_phone_registry where phone_e164 = $1', [phone])
    expect(registryRows.rows).toHaveLength(0)
    const driverRows = await pool.query('select 1 from drivers where phone = $1', [phone])
    expect(driverRows.rows).toHaveLength(0)
  })

  it('keeps the local reservation and returns success when an ambiguous Auth outcome is confirmed created by a follow-up lookup', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    let driverIdSeenByAuth: string | undefined
    const useCase = buildUseCase(fakeAuth({
      createUser: async (input) => { driverIdSeenByAuth = input.id; throw new AuthProviderUnknownOutcomeError('simulated timeout') },
      getUserEmail: async (id) => (id === driverIdSeenByAuth ? 'reconciled@example.test' : null)
    }))

    const { driverId } = await useCase.execute({ firstName: 'Timeout', lastName: 'ButCreated', email: 'reconciled@example.test', phone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })
    createdDriverIds.push(driverId)

    const row = await driverRow(driverId)
    expect(row).toBeDefined()
    const outboxRows = await pool.query('select 1 from outbox_event where aggregate_id = $1', [driverId])
    expect(outboxRows.rows).toHaveLength(0)
  })

  it('compensates and reports a retryable error (never 202-style parking) when a follow-up lookup CONFIRMS no Auth user was created', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const useCase = buildUseCase(fakeAuth({
      createUser: async () => { throw new AuthProviderUnknownOutcomeError('simulated timeout') },
      getUserEmail: async () => null // confirmed: no such Auth user exists
    }))

    await expect(useCase.execute({ firstName: 'Confirmed', lastName: 'Absent', email: `confirmed-absent-${randomUUID()}@example.test`, phone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: () => undefined } })).rejects.toBeInstanceOf(DriverProvisioningError)

    const registryRows = await pool.query('select 1 from account_phone_registry where phone_e164 = $1', [phone])
    expect(registryRows.rows).toHaveLength(0)
    const driverRows = await pool.query('select 1 from drivers where phone = $1', [phone])
    expect(driverRows.rows).toHaveLength(0)
  })

  it('never deletes the local reservation on a genuinely inconclusive Auth outcome, and records a durable reconciliation event instead', async () => {
    const phone = `+336${randomUUID().replace(/\D/g, '').slice(0, 8)}`
    const logged: unknown[] = []
    const useCase = buildUseCase(fakeAuth({
      createUser: async () => { throw new AuthProviderUnknownOutcomeError('simulated timeout') },
      getUserEmail: async () => { throw new Error('lookup also failed') }
    }))

    let driverId: string | undefined
    try {
      await useCase.execute({ firstName: 'Stuck', lastName: 'Pending', email: `stuck-${randomUUID()}@example.test`, phone, password: 'Strong!Pass1', correlationId: randomUUID(), logger: { error: (obj) => logged.push(obj) } })
      expect.unreachable('expected DriverSignupFinalizingError')
    } catch (error) {
      expect(error).toBeInstanceOf(DriverSignupFinalizingError)
    }

    const registryRows = await pool.query<{ account_id: string }>('select account_id from account_phone_registry where phone_e164 = $1', [phone])
    expect(registryRows.rows).toHaveLength(1)
    driverId = registryRows.rows[0]?.account_id
    expect(driverId).toBeDefined()
    if (driverId !== undefined) createdDriverIds.push(driverId)

    const driverRows = await pool.query('select 1 from drivers where id = $1', [driverId])
    expect(driverRows.rows).toHaveLength(1)
    const outboxRows = await pool.query('select event_type, payload from outbox_event where aggregate_id = $1', [driverId])
    expect(outboxRows.rows).toHaveLength(1)
    expect(outboxRows.rows[0]?.event_type).toBe('driver.signup.reconcile.v1')
    expect(logged.length).toBeGreaterThan(0)
  })
})
