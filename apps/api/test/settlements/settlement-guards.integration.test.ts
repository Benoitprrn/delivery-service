import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { createPaymentsModule, createStripeProvider } from '../../src/modules/payments/public.js'
import { PostgresDriverPayoutReadinessReader } from '../../src/modules/settlements/public.js'
import { createMerchantSettlementReadiness } from '../../src/modules/orders/public.js'

// Ces tests TRONQUENT/ÉCRIVENT des tables de règlement : ils ne tournent que sur une base isolée (`source docs/work/r10-testdb.sh`),
// jamais sur la base de dev (là, ils sont ignorés).
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')

// Base isolée requise (migration 0032 : `driver_connect_accounts`) : `source docs/work/r10-testdb.sh reset`.
const driverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5'
const driver2Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4'
const merchant2Id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'
const zoneId = '11111111-1111-1111-1111-111111111111'
const reader = new PostgresDriverPayoutReadinessReader(pool)

beforeAll(async () => {
  if (!isolated) return
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto 2',$2::uuid) on conflict do nothing", [merchant2Id, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 2',$2::uuid) on conflict do nothing", [driver2Id, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 5',$2::uuid) on conflict do nothing", [driverId, zoneId])
})
afterEach(async () => {
  if (!isolated) return
  await pool.query('delete from driver_payout_observations where driver_id = any($1::uuid[])', [[driverId, driver2Id]])
  await pool.query('delete from driver_connect_accounts where driver_id = any($1::uuid[])', [[driverId, driver2Id]])
  await pool.query('delete from merchant_payment_methods where merchant_id = $1', [merchant2Id])
})
afterAll(async () => {
  if (!isolated) return
  await pool.query('delete from drivers where id = any($1::uuid[])', [[driverId, driver2Id]])
  await pool.query('delete from merchants where id = $1::uuid', [merchant2Id])
})

interface Account { transfers?: string; payouts?: string; requirements?: string; restrictedAt?: string | null; entity?: string }
async function account(driver: string, over: Account = {}): Promise<void> {
  await pool.query(
    `insert into driver_connect_accounts(driver_id, stripe_account_id, entity_type, transfers_status, payouts_status, requirements_state, restricted_at, livemode)
     values($1::uuid, $2, $3, $4, $5, $6, ${over.restrictedAt ?? 'null'}, false)`,
    [driver, `acct_${driver.slice(-4)}`, over.entity ?? 'individual', over.transfers ?? 'active', over.payouts ?? 'active', over.requirements ?? 'none'])
}

describe.skipIf(!isolated)('D-F — driver payout readiness reads the local Connect account and fails closed', () => {
  it('is ready with an active account, for individuals AND companies', async () => {
    await account(driverId, { entity: 'individual' }); await account(driver2Id, { entity: 'company' })
    expect(await reader.isReady(driverId)).toBe(true)
    expect(await reader.isReady(driver2Id)).toBe(true)
  })

  it('is NOT ready without any account (never onboarded)', async () => {
    expect(await reader.isReady(driverId)).toBe(false)
  })

  it.each([
    ['onboarding incomplete (inactive)', { transfers: 'inactive' }],
    ['onboarding pending', { transfers: 'pending' }],
    ['restricted transfers', { transfers: 'restricted' }],
    ['unknown transfers state', { transfers: 'unknown' }],
    ['requirements past due', { requirements: 'past_due' }],
    ['account disabled', { requirements: 'disabled' }],
    ['restriction recorded (restricted_at)', { restrictedAt: 'now()' }]
  ])('is NOT ready: %s', async (_label, over) => {
    await account(driverId, over)
    expect(await reader.isReady(driverId)).toBe(false)
  })

  it.each([['eventually_due'], ['currently_due'], ['none']])('stays ready while Stripe only announces requirements (%s), as observed in the sandbox', async requirements => {
    await account(driverId, { requirements })
    expect(await reader.isReady(driverId)).toBe(true)
  })

  it('filters a batch of drivers and handles the empty list', async () => {
    await account(driverId); await account(driver2Id, { transfers: 'restricted' })
    expect([...(await reader.findReadyDriverIds([driverId, driver2Id, '99999999-9999-9999-9999-999999999999']))]).toEqual([driverId])
    expect((await reader.findReadyDriverIds([])).size).toBe(0)
  })
})

describe.skipIf(!isolated)('D-D — the real SEPA lookup: only an ACTIVE mandate counts', () => {
  const payments = createPaymentsModule(pool, createStripeProvider(false, undefined, undefined), async () => null, async () => null)
  const method = (status: string, n: number) => pool.query(
    'insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, status) values($1::uuid, $2, $3)', [merchant2Id, `seti_test_${status}_${n}`, status])

  it('is false without any method and for every non-active state', async () => {
    expect(await payments.hasActiveSepaMethod(merchant2Id)).toBe(false)
    let n = 0
    for (const status of ['setup_pending', 'invalid', 'detach_pending', 'detached']) {
      await method(status, n++)
      expect(await payments.hasActiveSepaMethod(merchant2Id)).toBe(false)
    }
  })

  it('is true with an active method and composes into the settlement readiness (fail closed on legal information)', async () => {
    await method('active', 1)
    expect(await payments.hasActiveSepaMethod(merchant2Id)).toBe(true)
    const legalComplete = createMerchantSettlementReadiness({ hasActiveSepaMethod: payments.hasActiveSepaMethod, isLegalInformationComplete: async () => true })
    const legalMissing = createMerchantSettlementReadiness({ hasActiveSepaMethod: payments.hasActiveSepaMethod, isLegalInformationComplete: async () => false })
    await expect(legalComplete.check(merchant2Id)).resolves.toEqual({ ready: true })
    await expect(legalMissing.check(merchant2Id)).resolves.toEqual({ ready: false, reason: 'legal_information_incomplete' })
    await expect(legalComplete.check('99999999-9999-9999-9999-999999999999')).resolves.toEqual({ ready: false, reason: 'sepa_not_configured' })
  })
})
