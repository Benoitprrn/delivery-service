import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresDriverConnectRepository } from '../../src/modules/settlements/public.js'

// Entités DÉDIÉES : ne perturbe aucune fixture partagée ; ne touche que ses propres lignes (base de dev ou isolée).
const driverId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb6'
const zoneId = '11111111-1111-1111-1111-111111111111'
const repository = new PostgresDriverConnectRepository(pool)
const status = (transfers: 'inactive' | 'pending' | 'active' | 'restricted', requirements: 'none' | 'eventually_due' | 'currently_due' | 'past_due' | 'disabled') => ({ transfers, payouts: transfers, requirements })

beforeAll(async () => { await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur 6',$2::uuid) on conflict do nothing", [driverId, zoneId]) })
afterEach(async () => { await pool.query('delete from driver_connect_accounts where driver_id = $1::uuid', [driverId]) })
afterAll(async () => { await pool.query('delete from drivers where id = $1::uuid', [driverId]) })

describe('PostgresDriverConnectRepository', () => {
  it('inserts once per driver (a second insert with another account is ignored) and finds the driver by Stripe account', async () => {
    await repository.insertIfAbsent({ driverId, stripeAccountId: 'acct_r30_a', entityType: 'company', livemode: false })
    await repository.insertIfAbsent({ driverId, stripeAccountId: 'acct_r30_b', entityType: 'individual', livemode: false })
    expect(await repository.findByDriverId(driverId)).toMatchObject({ stripeAccountId: 'acct_r30_a', entityType: 'company', transfersStatus: 'inactive', restrictedAt: null })
    expect(await repository.findDriverIdByAccountId('acct_r30_a')).toBe(driverId)
    expect(await repository.findDriverIdByAccountId('acct_r30_b')).toBeNull()
    expect(await repository.findByDriverId('99999999-9999-9999-9999-999999999999')).toBeNull()
  })

  it('a never-onboarded account that is restricted/past due is NOT flagged restricted_at (simply not ready)', async () => {
    await repository.insertIfAbsent({ driverId, stripeAccountId: 'acct_r30_c', entityType: 'individual', livemode: false })
    const updated = await repository.updateStatus(driverId, status('restricted', 'past_due'))
    expect(updated).toMatchObject({ transfersStatus: 'restricted', requirementsState: 'past_due', restrictedAt: null })
    expect(updated?.lastSyncedAt).not.toBeNull()
  })

  it('flags restricted_at when an ACTIVE account becomes restricted, keeps the first date, and clears it on regularization (D-F)', async () => {
    await repository.insertIfAbsent({ driverId, stripeAccountId: 'acct_r30_d', entityType: 'individual', livemode: false })
    expect((await repository.updateStatus(driverId, status('active', 'eventually_due')))?.restrictedAt).toBeNull()
    const first = (await repository.updateStatus(driverId, status('restricted', 'past_due')))?.restrictedAt
    expect(first).toBeInstanceOf(Date)
    await pool.query("update driver_connect_accounts set restricted_at = restricted_at - interval '1 hour' where driver_id = $1::uuid", [driverId])
    const sticky = (await repository.updateStatus(driverId, status('restricted', 'disabled')))?.restrictedAt
    expect(sticky?.getTime()).toBeLessThan((first as Date).getTime()) // la première date est conservée (coalesce)
    expect(await repository.updateStatus(driverId, status('active', 'none'))).toMatchObject({ transfersStatus: 'active', restrictedAt: null })
  })

  it('keeps an active account restricted while requirements are past due even if transfers still read active', async () => {
    await repository.insertIfAbsent({ driverId, stripeAccountId: 'acct_r30_e', entityType: 'individual', livemode: false })
    await repository.updateStatus(driverId, status('active', 'none'))
    expect((await repository.updateStatus(driverId, status('active', 'past_due')))?.restrictedAt).toBeInstanceOf(Date)
  })

  it('returns null when updating an unknown driver', async () => {
    expect(await repository.updateStatus('99999999-9999-9999-9999-999999999999', status('active', 'none'))).toBeNull()
  })
})
