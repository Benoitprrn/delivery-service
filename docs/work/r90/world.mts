// R90 — phase « world » : 10 restaurants (Account v2 client + mandat SEPA Sandbox), 5 livreurs (compte Connect Sandbox), commandes de la semaine du 24/08/2026.
// Objets Stripe tagués `run_id`. Base jetable settlements_r90 uniquement ; aucune protection PostgreSQL touchée.
import fs from 'node:fs'
import { RUN_ID, REPO, evidence, guardStripeId, log, newPool, r90Metadata, sandboxStripe } from './lib.mts'

const stripe = sandboxStripe()
const pool = newPool()
const zoneId = '11111111-1111-1111-1111-111111111111'
const IBAN = { success: 'AT611904300234573201', failImmediate: 'AT861904300235473202', failDelayed: 'AT051904300235473205', disputed: 'AT591904300235473203' }
const uuid = (kind: 'm' | 'd', n: number) => `90000000-0000-4000-8000-${kind === 'm' ? '0000000000' : '0000000001'}${String(n).padStart(2, '0')}`

const r90Merchant = (await pool.query("select id from merchants where name = 'Restaurant R90 (test)'")).rows[0].id as string
const r90Driver = (await pool.query("select id from drivers where name = 'Livreur R90 (test)'")).rows[0].id as string
const restaurants = [
  { n: 1, id: r90Merchant, name: 'Restaurant R90 (test)', iban: IBAN.success, behaviour: 'succès' },
  { n: 2, id: '22222222-2222-2222-2222-222222222222', name: 'Restaurant Le Terminus', iban: IBAN.success, behaviour: 'succès' },
  ...[3, 4, 5, 6, 7].map((n) => ({ n, id: uuid('m', n), name: `R90 Resto ${String(n).padStart(2, '0')}`, iban: IBAN.success, behaviour: 'succès' })),
  { n: 8, id: uuid('m', 8), name: 'R90 Resto 08', iban: IBAN.disputed, behaviour: 'succès puis litige' },
  { n: 9, id: uuid('m', 9), name: 'R90 Resto 09', iban: IBAN.failImmediate, behaviour: 'échec immédiat' },
  { n: 10, id: uuid('m', 10), name: 'R90 Resto 10', iban: IBAN.failDelayed, behaviour: 'échec différé' },
]
const drivers = [
  { n: 1, id: r90Driver, name: 'Livreur R90 (test)' },
  { n: 2, id: '33333333-3333-3333-3333-333333333333', name: 'Jean-Paul' },
  ...[3, 4, 5].map((n) => ({ n, id: uuid('d', n), name: `R90 Livreur ${n}` })),
]

const state: any = { runId: RUN_ID, restaurants: {}, drivers: {} }
await Promise.all(restaurants.map(async (r) => {
  const account = await stripe.v2.core.accounts.create({ configuration: { customer: {} }, metadata: r90Metadata({ role: 'restaurant', slot: `R${r.n}` }) })
  guardStripeId(account.id)
  const si = await stripe.setupIntents.create({
    customer_account: account.id, payment_method_types: ['sepa_debit'], usage: 'off_session', confirm: true,
    payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: r.iban }, billing_details: { name: r.name, email: `r90-resto-${r.n}@example.com` } },
    mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '127.0.0.1', user_agent: 'r90-harness' } } }, metadata: r90Metadata({ slot: `R${r.n}` }),
  })
  const pm = await stripe.paymentMethods.retrieve(si.payment_method)
  const mandate = await stripe.mandates.retrieve(si.mandate)
  await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [r.id, r.name, zoneId])
  await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values($1::uuid,$2) on conflict (merchant_id) do update set stripe_account_id = excluded.stripe_account_id', [r.id, account.id])
  await pool.query(`insert into merchant_payment_methods(merchant_id, stripe_setup_intent_id, stripe_payment_method_id, stripe_mandate_id, status, last4, country, mandate_reference, activated_at) values($1::uuid,$2,$3,$4,'active',$5,'AT',$6,now())`, [r.id, si.id, pm.id, mandate.id, pm.sepa_debit?.last4, mandate.payment_method_details?.sepa_debit?.reference])
  state.restaurants[`R${r.n}`] = { id: r.id, name: r.name, behaviour: r.behaviour, account: account.id, paymentMethod: pm.id, mandate: mandate.id }
}))

await Promise.all(drivers.map(async (d) => {
  const tok = await stripe.tokens.create({ account: { business_type: 'individual', individual: { first_name: 'Jean', last_name: `Livreur${d.n}`, email: `r90-driver-${d.n}@example.com`, phone: '+33612345678', dob: { day: 1, month: 1, year: 1990 }, address: { line1: '1 rue de la Paix', city: 'Paris', postal_code: '75002', country: 'FR' } }, tos_shown_and_accepted: true } })
  const acct = await stripe.accounts.create({ type: 'custom', country: 'FR', account_token: tok.id, business_profile: { mcc: '4215', url: 'https://accessible.stripe.com', product_description: 'Livraison last-mile (R90 sandbox)' }, capabilities: { transfers: { requested: true } }, external_account: { object: 'bank_account', country: 'FR', currency: 'eur', account_number: 'FR1420041010050500013M02606' }, metadata: r90Metadata({ role: 'driver', slot: `D${d.n}` }) })
  guardStripeId(acct.id)
  await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [d.id, d.name, zoneId])
  state.drivers[`D${d.n}`] = { id: d.id, name: d.name, account: acct.id }
}))
await new Promise((r) => setTimeout(r, 6000))
for (const [slot, d] of Object.entries<any>(state.drivers)) {
  const a = await stripe.accounts.retrieve(d.account)
  d.transfers = a.capabilities?.transfers
  await pool.query(`insert into driver_connect_accounts(driver_id,stripe_account_id,entity_type,livemode,transfers_status,payouts_status,requirements_state) values($1::uuid,$2,'individual',false,$3,'active','none') on conflict (driver_id) do update set stripe_account_id = excluded.stripe_account_id, transfers_status = excluded.transfers_status`, [d.id, d.account, a.capabilities?.transfers === 'active' ? 'active' : 'pending'])
  log(`livreur ${slot}`, { transfers: d.transfers })
}

// Commandes : matrice livreur × restaurant (gain figé stocké à la création, comme en production). Semaine du 24/08 (après go_live_at) ; 1 commande antérieure à go_live_at (exclue).
const matrix: Array<[number, number, number[]]> = [
  ...restaurants.map((r): [number, number, number[]] => [1, r.n, [400 + 50 * r.n]]),                     // D1 × 10 restaurants
  ...[1, 2, 3, 4, 5, 6].map((n): [number, number, number[]] => [2, n, [480 + 10 * n, 620 + 10 * n]]),    // D2 × 6 restaurants (2 courses chacun)
  [3, 1, [530]], [3, 2, [610]], [4, 3, [455]], [5, 4, [505]], [5, 5, [495]],                              // D3, D4, D5
]
let i = 0
for (const [dn, rn, earnings] of matrix) {
  for (const e of earnings) {
    const created = new Date(Date.UTC(2026, 7, 24, 8 + (i % 10), i % 60))
    const completed = new Date(created.getTime() + (24 + (i % 90)) * 3600_000)
    // `price_cents` est GÉNÉRÉ depuis distance/durée (ADR 0002) et, comme en production, `driver_earning_cents` = `price_cents` (0034 : passage unique de 0 à price_cents).
    // `e` ne sert plus qu'à faire varier la distance (courses de 2,5 à 9 km).
    const inserted = await pool.query(`insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
      values(gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'COMPLETED','Client R90','0600000000','P',46.2,5.2,'D',46.21,5.21,$4::int,$5::int,0,$6,$7) returning id`,
      [state.restaurants[`R${rn}`].id, state.drivers[`D${dn}`].id, zoneId, 2000 + e * 8, 600 + e, created, completed])
    await pool.query('update orders set driver_earning_cents = price_cents where id = $1::uuid', [inserted.rows[0].id])
    i += 1
  }
}
// commande antérieure à go_live_at : doit être exclue et comptée
await pool.query(`insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
  values(gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'COMPLETED','Client R90','0600000000','P',46.2,5.2,'D',46.21,5.21,3000,600,0,'2026-08-17 08:00:00+00','2026-08-27 10:00:00+00')`, [state.restaurants.R1.id, state.drivers.D1.id, zoneId])
await pool.query("update orders set driver_earning_cents = price_cents where created_at < '2026-08-20'")
state.orders = { settleable: i, preGoLive: 1 }
fs.mkdirSync(`${REPO}/docs/work/r90/evidence`, { recursive: true })
fs.writeFileSync(`${REPO}/docs/work/r90/evidence/state-${RUN_ID}.json`, JSON.stringify(state, null, 1))
evidence('world', 'OK', ['TST-11', 'DAT-11'], { restaurants: Object.keys(state.restaurants).length, drivers: Object.fromEntries(Object.entries<any>(state.drivers).map(([k, d]) => [k, d.transfers])), orders: state.orders })
await pool.end()
