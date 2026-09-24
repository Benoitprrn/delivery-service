import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresDriverEInvoiceMandateRepository, DriverEInvoiceMandateAlreadyExistsError } from '../../src/modules/invoices/public.js'
import { lockInvoiceTables } from '../support/invoice-tables-lock.js'
// Même contention que les autres tests d'intégration `modules/invoices` sérialisés par
// `lockInvoiceTables` (voir einvoice-work-repository.integration.test.ts) : le `beforeAll` peut
// attendre son tour au-delà du hookTimeout par défaut (10s) quand plusieurs fichiers concurrents
// tiennent le même verrou consultatif.
vi.setConfig({ hookTimeout: 60_000 })
const isolated = /invoice|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const driverId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; const repo = new PostgresDriverEInvoiceMandateRepository(pool); let release: (() => Promise<void>) | undefined
const snapshot = { firstNameSnapshot: 'Jean', lastNameSnapshot: 'Martin', siren: '123456789', legalNameSnapshot: 'Pro', nameSnapshot: 'Jean Martin', professionalNameSnapshot: 'Pro', siretSnapshot: '12345678900012', legalAddressLine1Snapshot: '1 rue', legalAddressLine2Snapshot: null, legalAddressPostalCodeSnapshot: '01000', legalAddressCitySnapshot: 'Bourg', legalAddressCountryCodeSnapshot: 'FR', vatNumberSnapshot: null, vatRegimeSnapshot: null, legalFormSnapshot: null } as const
async function insert(): Promise<unknown> { return repo.insert({ id: randomUUID(), driverId, snapshot, mandateTemplateVersion: 1, mandateTextHash: 'hash', acceptedAt: new Date(), acceptanceEvidence: {}, signedPdfStoragePath: `test/${randomUUID()}`, signedPdfSha256: randomUUID() }) }
beforeAll(async () => { if (!isolated) return; release = await lockInvoiceTables(pool); await pool.query("insert into drivers(id,name,zone_id) select $1::uuid,'Driver mandate test',id from zones limit 1 on conflict do nothing", [driverId]) })
afterAll(async () => {
  if (!isolated) return
  // `driver_einvoice_mandates` never allows DELETE (immutability trigger, even for a revoked row) —
  // TRUNCATE bypasses row-level triggers and is the established pattern for cleaning append-only
  // tables between disposable-DB test runs (see `einvoice-work-repository.integration.test.ts`).
  await pool.query('truncate table driver_einvoice_mandates')
  await pool.query('delete from drivers where id=$1::uuid', [driverId])
  await release?.()
})
describe.skipIf(!isolated)('driver electronic invoice mandate repository (isolated DB only)', () => { it('finds current, ignores revoked, and maps current-index races', async () => { const inserted = await insert(); expect(await repo.findCurrent(driverId)).toMatchObject({ id: (inserted as { id: string }).id }); await expect(insert()).rejects.toBeInstanceOf(DriverEInvoiceMandateAlreadyExistsError); await pool.query("update driver_einvoice_mandates set revoked_at=now(), revocation_reason='test' where driver_id=$1::uuid", [driverId]); expect(await repo.findCurrent(driverId)).toBeNull() }) })
