// R90 run 4 — préparation minimale : 2 comptes livreur SANS compte Stripe (onboarding réel via l'app), + admin déjà existants réutilisés.
// Base jetable settlements_r90 (fraîche, run4) uniquement.
import fs from 'node:fs'
import { CREDENTIALS_FILE, RUN_ID, authAdminCreateUser, authAdminListUsers, authAdminSetPassword, log, newPool, randomPassword } from './lib.mts'

const pool = newPool()
const zoneId = '11111111-1111-1111-1111-111111111111'
const users = await authAdminListUsers()
const creds: Record<string, string> = {}
const ensure = async (email: string, role: 'merchant' | 'driver' | 'admin'): Promise<string> => {
  const pw = randomPassword()
  const existing = users.find((u) => u.email === email)
  let id: string
  if (existing) { id = existing.id; await authAdminSetPassword(id, pw) } else id = await authAdminCreateUser(email, pw, role)
  creds[email] = pw
  return id
}

await ensure('admin.dev@locadely.test', 'admin')
await ensure('admin2.dev@locadely.test', 'admin')
const merchantId = await ensure('r90.merchant@locadely.test', 'merchant')
const driverIndividualId = await ensure('r90.driver.individual@locadely.test', 'driver')
const driverCompanyId = await ensure('r90.driver.company@locadely.test', 'driver')

fs.writeFileSync(CREDENTIALS_FILE, Object.entries(creds).map(([e, p]) => `${e} ${p}`).join('\n') + '\n', { mode: 0o600 })

await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [merchantId, 'Restaurant R90 (test)', zoneId])
await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [driverIndividualId, 'Livreur R90 Individual (test)', zoneId])
await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [driverCompanyId, 'Livreur R90 Company (test)', zoneId])

log('run4-prep OK', { runId: RUN_ID, merchantId, driverIndividualId, driverCompanyId })
await pool.end()
