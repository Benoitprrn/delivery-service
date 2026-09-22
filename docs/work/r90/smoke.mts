// R90 — smoke test : Supabase Auth + livreur + restaurant + admin + accès « Mes paiements » via l'instance API R90 (port 3100).
import fs from 'node:fs'
import { CREDENTIALS_FILE, RUN_ID, api, authAdminCreateUser, authAdminListUsers, authAdminSetPassword, evidence, log, newPool, randomPassword, signIn } from './lib.mts'

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
// Les deux comptes admin de test sont ré-initialisés (nouveaux mots de passe, fichier privé hors dépôt).
await ensure('admin.dev@locadely.test', 'admin')
await ensure('admin2.dev@locadely.test', 'admin')
const merchantId = await ensure('r90.merchant@locadely.test', 'merchant')
const driverId = await ensure('r90.driver@locadely.test', 'driver')
fs.writeFileSync(CREDENTIALS_FILE, Object.entries(creds).map(([e, p]) => `${e} ${p}`).join('\n') + '\n', { mode: 0o600 })
await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [merchantId, 'Restaurant R90 (test)', zoneId])
await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [driverId, 'Livreur R90 (test)', zoneId])

const tAdmin = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!)
const tMerchant = await signIn('r90.merchant@locadely.test', creds['r90.merchant@locadely.test']!)
const tDriver = await signIn('r90.driver@locadely.test', creds['r90.driver@locadely.test']!)
const checks: Array<[string, number, number]> = []
const expect = async (label: string, want: number, method: string, path: string, token?: string) => { const r = await api(method, path, token); checks.push([label, want, r.status]); return r }
const dr = await expect('livreur GET /drivers/me/settlements', 200, 'GET', '/api/v1/drivers/me/settlements', tDriver)
const mr = await expect('restaurant GET /merchants/me/settlements', 200, 'GET', '/api/v1/merchants/me/settlements', tMerchant)
const ar = await expect('admin GET /admin/settlements/overview', 200, 'GET', '/api/v1/admin/settlements/overview', tAdmin)
await expect('anonyme -> 401', 401, 'GET', '/api/v1/admin/settlements/overview')
await expect('restaurant sur route admin -> 403', 403, 'GET', '/api/v1/admin/settlements/overview', tMerchant)
await expect('livreur sur route restaurant -> 403', 403, 'GET', '/api/v1/merchants/me/settlements', tDriver)
await expect('admin sur route livreur -> 403', 403, 'GET', '/api/v1/drivers/me/settlements', tAdmin)
const ok = checks.every(([, want, got]) => want === got)
evidence('smoke-auth-api', ok ? 'OK' : 'KO', ['TST-01', 'DAT-11', 'WEB-07', 'MOB-13'], { checks: checks.map(([l, w, g]) => `${l}: attendu ${w}, obtenu ${g}`), driverBody: dr.json, merchantBody: Object.keys(mr.json ?? {}), adminBody: Object.keys(ar.json ?? {}), runId: RUN_ID, merchantId, driverId })
await pool.end()
process.exit(ok ? 0 : 1)
