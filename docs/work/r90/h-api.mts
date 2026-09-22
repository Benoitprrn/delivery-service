// R90 H (partie automatisable) — lecture des 3 vues via l'API R90 réelle sur les données de la campagne : livreur D1, restaurant R1, admin.
import fs from 'node:fs'
import { CREDENTIALS_FILE, api, evidence, log, signIn } from './lib.mts'
import { pool } from './uc.mts'
const creds = Object.fromEntries(fs.readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ') as [string, string]))
const tDriver = await signIn('r90.driver@locadely.test', creds['r90.driver@locadely.test']!)
const tMerchant = await signIn('r90.merchant@locadely.test', creds['r90.merchant@locadely.test']!)
const tAdmin = await signIn('admin.dev@locadely.test', creds['admin.dev@locadely.test']!)
const d = await api('GET', '/api/v1/drivers/me/settlements', tDriver)
const m = await api('GET', '/api/v1/merchants/me/settlements', tMerchant)
const a = await api('GET', '/api/v1/admin/settlements/overview', tAdmin)
const states = (d.json.periods ?? []).flatMap((p: any) => (p.statements ?? []).map((s: any) => s.displayState ?? s.state))
const count = (xs: string[]) => xs.reduce((acc: any, x) => { acc[x] = (acc[x] ?? 0) + 1; return acc }, {})
log('livreur D1', { status: d.status, identityVisible: d.json.identityVisible, periods: d.json.periods?.length, totals: d.json.totals, currentWeek: d.json.currentWeek, states: count(states) })
const mset = m.json.settlements ?? []
log('restaurant R1', { status: m.status, settlements: mset.length, first: mset[0] })
const leakKeys = JSON.stringify(m.json).match(/driver_earning|driverEarning|fee_cents|feeCents|stripe|acct_|net_cents/gi) ?? []
log('overview admin', { status: a.status, settlements: a.json.settlements?.length, incidents: a.json.incidents?.length, receivables: a.json.receivables?.length, findings: a.json.findings?.length, transfers: a.json.transfers?.length, reversals: a.json.reversals?.length, blocked: a.json.blockedStatements?.length, deadLetters: a.json.deadLetters?.length })
const driverPeriodsJson = JSON.stringify(d.json)
const identityLeak = /R90 Resto|Restaurant R90|legalName|siret/i.test(driverPeriodsJson)
const ok = d.status === 200 && m.status === 200 && a.status === 200 && (d.json.periods?.length ?? 0) >= 2 && mset.length >= 1 && leakKeys.length === 0 && !identityLeak
evidence('H-api-readmodel', ok ? 'OK' : 'KO', ['MOB-13', 'WEB-07', 'LEG-11'], { driver: { periods: d.json.periods?.length, totals: d.json.totals, states: count(states), identityVisible: d.json.identityVisible, restaurantNameLeak: identityLeak }, merchant: { settlements: mset.length, forbiddenKeysFound: leakKeys }, admin: { incidents: a.json.incidents?.length, receivables: a.json.receivables?.length, findings: a.json.findings?.length, transfers: a.json.transfers?.length, reversals: a.json.reversals?.length, deadLetters: a.json.deadLetters?.length } })
await pool.end()
