// R90 run4 — monde minimal ciblé (D-R, pas de campagne massive) : 2 restaurants (Account v2 + mandat SEPA succès),
// commandes pour les 2 VRAIS livreurs onboardés depuis l'app (individual + company, Express v2, déjà onboardés).
// Objets Stripe tagués run_id. Base jetable settlements_r90 (run4) uniquement.
import fs from 'node:fs'
import { RUN_ID, REPO, evidence, log, newPool, r90Metadata, sandboxStripe } from './lib.mts'

const stripe = sandboxStripe()
const pool = newPool()
const zoneId = '11111111-1111-1111-1111-111111111111'
const IBAN_SUCCESS = 'AT611904300234573201'

const r1Id = (await pool.query("select id from merchants where name = 'Restaurant R90 (test)'")).rows[0].id as string
const dIndividual = (await pool.query("select id from drivers where name = 'Livreur R90 Individual (test)'")).rows[0].id as string
const dCompany = (await pool.query("select id from drivers where name = 'Livreur R90 Company (test)'")).rows[0].id as string
const accIndividual = (await pool.query('select stripe_account_id from driver_connect_accounts where driver_id = $1::uuid', [dIndividual])).rows[0].stripe_account_id as string
const accCompany = (await pool.query('select stripe_account_id from driver_connect_accounts where driver_id = $1::uuid', [dCompany])).rows[0].stripe_account_id as string

const r2Id = '90000000-0000-4000-8000-000000000002'
const restaurants = [
  { n: 1, id: r1Id, name: 'Restaurant R90 (test)' },
  { n: 2, id: r2Id, name: 'R90 Resto 02' },
]

const state: any = { runId: RUN_ID, restaurants: {}, drivers: {} }
await Promise.all(restaurants.map(async (r) => {
  const account = await stripe.v2.core.accounts.create({ configuration: { customer: {} }, metadata: r90Metadata({ role: 'restaurant', slot: `R${r.n}` }) })
  const si = await stripe.setupIntents.create({
    customer_account: account.id, payment_method_types: ['sepa_debit'], usage: 'off_session', confirm: true,
    payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: IBAN_SUCCESS }, billing_details: { name: r.name, email: `r90-resto-${r.n}@example.com` } },
    mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'r90-harness' } } }, metadata: r90Metadata({ slot: `R${r.n}` }),
  })
  const pm = await stripe.paymentMethods.retrieve(si.payment_method)
  const mandate = await stripe.mandates.retrieve(si.mandate)
  await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [r.id, r.name, zoneId])
  await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values($1::uuid,$2) on conflict (merchant_id) do update set stripe_account_id = excluded.stripe_account_id', [r.id, account.id])
  await pool.query(`insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, stripe_payment_method_id, stripe_mandate_id, status, last4, country, mandate_reference, activated_at) values($1::uuid,$2,$3,$4,'active',$5,'AT',$6,now())`, [r.id, si.id, pm.id, mandate.id, pm.sepa_debit?.last4, mandate.payment_method_details?.sepa_debit?.reference])
  state.restaurants[`R${r.n}`] = { id: r.id, name: r.name, account: account.id, paymentMethod: pm.id, mandate: mandate.id }
}))

state.drivers.Dindividual = { id: dIndividual, name: 'Livreur R90 Individual (test)', account: accIndividual }
state.drivers.Dcompany = { id: dCompany, name: 'Livreur R90 Company (test)', account: accCompany }

// Matrice ciblée : individual × R1 (2 courses), individual × R2 (1), company × R1 (1), company × R2 (2). Semaine du 24/08/2026 (après go_live_at).
const matrix: Array<[string, string, number[]]> = [
  [dIndividual, r1Id, [420, 560]],
  [dIndividual, r2Id, [500]],
  [dCompany, r1Id, [610]],
  [dCompany, r2Id, [470, 530]],
]
let i = 0
for (const [driverId, merchantId, earnings] of matrix) {
  for (const e of earnings) {
    const created = new Date(Date.UTC(2026, 7, 25, 8 + i, i % 60))
    const completed = new Date(created.getTime() + (24 + i * 3) * 3600_000)
    const inserted = await pool.query(`insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
      values(gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'COMPLETED','Client R90','0600000000','P',46.2,5.2,'D',46.21,5.21,$4::int,$5::int,0,$6,$7) returning id`,
      [merchantId, driverId, zoneId, 2000 + e * 8, 600 + e, created, completed])
    await pool.query('update orders set driver_earning_cents = price_cents, delivery_cents = price_cents, service_fee_cents = floor(price_cents * 2000 / 10000) where id = $1::uuid', [inserted.rows[0].id])
    i += 1
  }
}
state.orders = { settleable: i }
fs.mkdirSync(`${REPO}/docs/work/r90/evidence`, { recursive: true })
fs.writeFileSync(`${REPO}/docs/work/r90/evidence/state-${RUN_ID}.json`, JSON.stringify(state, null, 1))
evidence('run4-world', 'OK', ['TST-11', 'DAT-11', 'STR-01', 'STR-13'], { restaurants: Object.keys(state.restaurants).length, drivers: state.drivers, orders: state.orders })
await pool.end()
