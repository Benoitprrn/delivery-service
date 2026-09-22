/**
 * T40a — E2E COD contre Stripe SANDBOX RÉEL (API réelle en process, DB locale de dev, Stripe Connect réel).
 * Seul le matériel est simulé : un lecteur simulé Stripe (server-driven) autorise le PaymentIntent à la place du WisePad 3.
 * Aucun faux Stripe, aucun faux PaymentIntent, aucune simulation de capture/webhook/logique métier.
 *
 *   npx tsx scripts/e2e/cod-sandbox-e2e.ts <poc-accounts.json>
 *
 * Écrit UNIQUEMENT dans la DB locale (marchands/commandes de test préfixés `e2e`) et nettoie à la fin.
 * N'utilise aucun Supabase distant en écriture (connexion du livreur de test = lecture d'auth seulement).
 * Jamais de live : clé `sk_test_/rk_test_` exigée. Ne touche pas au compte SEPA existant.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Stripe from 'stripe'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé Stripe absente ou non Sandbox.'); process.exit(1) }
process.env.STRIPE_PAYMENTS_ENABLED = 'true'
process.env.TERMINAL_ALLOW_SIMULATED_READER = 'true' // Sandbox uniquement ; refusé par défaut

const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
const state = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as { createdBy?: string; A?: string; B?: string }
if (state.createdBy !== 's1c' || !state.A || !state.B || state.A === state.B || FORBIDDEN.has(state.A) || FORBIDDEN.has(state.B)) { console.error('État A/B invalide.'); process.exit(1) }
const ACC = { A: state.A, B: state.B }

const [{ buildApp }, { pool }, { createOrdersModule }, { getDriverAccessToken }] = await Promise.all([
  import('../../apps/api/src/app.js'),
  import('../../apps/api/src/platform/db.js'),
  import('../../apps/api/src/modules/orders/public.js'),
  import('../../apps/api/test/support/get-driver-access-token.js')
])

const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const DRIVER = '33333333-3333-3333-3333-333333333333'
const SOURCE_MERCHANT = '22222222-2222-2222-2222-222222222222'
const MERCHANT = { A: 'e2e00000-0000-4000-8000-00000000000a', B: 'e2e00000-0000-4000-8000-00000000000b' }
const results: Array<{ ok: boolean; check: string; detail?: string }> = []
const createdOrders: string[] = []
const check = (ok: boolean, name: string, detail?: string) => { results.push({ ok, check: name, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`) }

const orders = createOrdersModule(pool, process.env.OSRM_URL ?? 'http://localhost:5000', async () => ({ lat: 46.2, lng: 5.2 }), undefined, { increment: async () => undefined, decrement: async () => undefined })

async function ensureMerchant(label: 'A' | 'B'): Promise<void> {
  const id = MERCHANT[label]
  const src = (await pool.query('select * from merchants where id = $1', [SOURCE_MERCHANT])).rows[0]
  if (src === undefined) throw new Error('Marchand source introuvable')
  const columns = Object.keys(src).filter((c) => c !== 'id')
  const values = columns.map((c) => (c === 'name' ? `E2E Restaurant ${label}` : c === 'email' ? `e2e-${label.toLowerCase()}@example.invalid` : src[c]))
  await pool.query(`insert into merchants (id, ${columns.map((c) => `"${c}"`).join(', ')}) values ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}) on conflict (id) do nothing`, [id, ...values])
  // Le Terminal Location Stripe exige une adresse : les infos légales font partie des prérequis COD.
  await pool.query("insert into merchant_legal_information (merchant_id, siret, siren, legal_name, legal_address_line1, legal_address_postal_code, legal_address_city, sirene_verification_status) values ($1, '12345678901234', '123456789', $2, '1 Rue de la République', '01000', 'Bourg-en-Bresse', 'unverified') on conflict (merchant_id) do nothing", [id, `E2E Restaurant ${label}`])
  await pool.query('insert into merchant_payment_profiles (merchant_id, stripe_account_id) values ($1, $2) on conflict (merchant_id) do update set stripe_account_id = excluded.stripe_account_id', [id, ACC[label]])
}

async function newCollectedOrder(label: 'A' | 'B', cod = true) {
  const merchantId = MERCHANT[label]
  const m = (await pool.query('select id, name, zone_id, address from merchants where id = $1', [merchantId])).rows[0]
  const made = await orders.createOrder({
    merchant: { id: m.id, name: m.name, zoneId: m.zone_id, address: m.address, phonePrimary: '0', phoneSecondary: null, logoUrl: null, lat: 46.2, lng: 5.2, onboardingCompleted: true },
    zone: { id: m.zone_id, name: 'z', centerLat: 46.2, centerLng: 5.2, radiusKm: 10 },
    customerName: 'Client E2E', customerPhone: '0600000000', deliveryAddress: 'Adresse E2E', deliveryLat: 46.21, deliveryLng: 5.21,
    pickupScheduledAt: { mode: 'asap' }, ...(cod ? { cashOnDelivery: { amountCents: 5000 } } : {})
  })
  createdOrders.push(made.id)
  const assigned = await orders.assignOrder({ orderId: made.id, driverId: DRIVER, expectedVersion: made.version, actor: { type: 'driver', id: DRIVER } })
  const collected = await orders.collectOrder({ orderId: made.id, driverId: DRIVER, expectedVersion: assigned.version, actor: { type: 'driver', id: DRIVER } })
  const code = (await orders.getMerchantOrders(merchantId)).find((o) => o.id === made.id)?.deliveryCode
  if (code === undefined) throw new Error('code de livraison introuvable')
  return { id: made.id, version: collected.version, code }
}

async function authorizeWithSimulatedReader(account: string, locationId: string, paymentIntentId: string, card: string): Promise<void> {
  const list = await stripe.terminal.readers.list({ location: locationId, limit: 5 }, { stripeAccount: account })
  const reader = list.data[0] ?? await stripe.terminal.readers.create({ registration_code: 'simulated-s700', location: locationId, label: 'E2E simulé' }, { stripeAccount: account })
  await stripe.terminal.readers.processPaymentIntent(reader.id, { payment_intent: paymentIntentId }, { stripeAccount: account })
  await (stripe.testHelpers.terminal.readers as any).presentPaymentMethod(reader.id, { type: 'card_present', card_present: { number: card } }, { stripeAccount: account })
  for (let i = 0; i < 12; i++) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: account })
    if (pi.status !== 'requires_payment_method' || pi.last_payment_error) return
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function main(): Promise<void> {
  const driverToken = await getDriverAccessToken()
  const app = await buildApp()
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers: { authorization: `Bearer ${driverToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) })
    return { status: res.statusCode, body: (() => { try { return res.json() as any } catch { return null } })() }
  }
  try {
    for (const label of ['A', 'B'] as const) await ensureMerchant(label)

    for (const label of ['A', 'B'] as const) {
      const other = label === 'A' ? 'B' : 'A'
      console.log(`\n=== Restaurant ${label} (${ACC[label]}) — parcours nominal ===`)
      const o = await newCollectedOrder(label)
      const legacy = await call('POST', `/api/v1/orders/${o.id}/complete`, { expectedVersion: o.version, proof: { method: 'code', code: o.code } })
      check(legacy.status === 409 && legacy.body?.error === 'CashOnDeliveryPaymentRequired', `${label}: complete legacy refusé tant que non encaissé`, `${legacy.status} ${legacy.body?.error}`)
      const created = await call('POST', `/api/v1/orders/${o.id}/delivery-completion-sessions`, { expectedVersion: o.version, deliveryCode: o.code, readerFamily: 'simulated_bluetooth' })
      check(created.status === 201 && created.body?.status === 'payment_required', `${label}: session + paiement créés`, `${created.status} ${created.body?.status ?? created.body?.error}`)
      const payment = created.body?.payment
      const sessionId = created.body?.sessionId as string
      if (payment === undefined) continue
      const pi = await stripe.paymentIntents.retrieve(await piIdOf(payment.id), { expand: ['latest_charge'] }, { stripeAccount: ACC[label] })
      check(pi.amount === 5000 && pi.currency === 'eur', `${label}: PI existe sur le compte du restaurant, 5000 EUR`, `${pi.id} ${pi.amount} ${pi.currency}`)
      check(pi.capture_method === 'manual' && pi.payment_method_types.join() === 'card_present', `${label}: capture manuelle, card_present`)
      check(pi.application_fee_amount === null && pi.transfer_data === null && pi.on_behalf_of === null, `${label}: aucune commission/transfert/on_behalf_of Locadely`)
      let contaminated = false
      try { await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: ACC[other] }) } catch (e: any) { contaminated = e?.code !== 'resource_missing' }
      check(!contaminated, `${label}: PI absent du compte ${other} (aucune contamination)`)
      const token = await call('POST', `/api/v1/orders/${o.id}/terminal/connection-token`, {})
      check(token.status === 200 && String(token.body?.secret ?? '').startsWith('pst_'), `${label}: token Terminal émis par le serveur pour la session`, `${token.status}`)
      await authorizeWithSimulatedReader(ACC[label], payment.terminalLocationId, pi.id, '4242424242424242')
      const fin = await call('POST', `/api/v1/orders/${o.id}/delivery-completion-sessions/${sessionId}/finalize`, { paymentId: payment.id })
      check(fin.status === 200 && fin.body?.status === 'completed', `${label}: finalize → COMPLETED`, `${fin.status} ${fin.body?.status ?? fin.body?.error}`)
      const done = await stripe.paymentIntents.retrieve(pi.id, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: ACC[label] })
      const charge: any = done.latest_charge
      const fees: any[] = charge?.balance_transaction?.fee_details ?? []
      check(done.status === 'succeeded' && done.amount_received === 5000 && charge?.captured === true, `${label}: capture réussie (5000)`, `${done.status}`)
      check(fees.every((f) => f.type === 'stripe_fee') && charge?.application_fee === null, `${label}: frais = Stripe seul (aucun application_fee)`, fees.map((f) => `${f.type}:${f.amount}`).join(','))
      const row = (await pool.query('select o.status, o.cash_on_delivery_collected_at is not null as collected, p.status as pstatus, s.status as sstatus, (select count(*) from order_events e where e.order_id = o.id and e.to_status = $2)::int as ev from orders o join order_cash_on_delivery_payments p on p.order_id = o.id join order_delivery_completion_sessions s on s.id = p.session_id where o.id = $1', [o.id, 'COMPLETED'])).rows[0]
      check(row?.status === 'COMPLETED' && row.collected === true && row.pstatus === 'captured' && row.sstatus === 'completed' && row.ev === 1, `${label}: état local cohérent (commande/paiement/session/événement)`, JSON.stringify(row))
      const again = await call('POST', `/api/v1/orders/${o.id}/delivery-completion-sessions/${sessionId}/finalize`, { paymentId: payment.id })
      check(again.status === 200, `${label}: finalize rejoué idempotent`, `${again.status}`)
    }

    console.log('\n=== Refus carte puis nouvelle tentative (restaurant A) ===')
    const d = await newCollectedOrder('A')
    const s1 = await call('POST', `/api/v1/orders/${d.id}/delivery-completion-sessions`, { expectedVersion: d.version, deliveryCode: d.code, readerFamily: 'simulated_bluetooth' })
    const p1 = s1.body?.payment
    await authorizeWithSimulatedReader(ACC.A, p1.terminalLocationId, await piIdOf(p1.id), '4000000000000002')
    const declined = await call('POST', `/api/v1/orders/${d.id}/delivery-completion-sessions/${s1.body.sessionId}/finalize`, { paymentId: p1.id })
    check(declined.status === 409 && declined.body?.error === 'PaymentDeclined', 'A: carte refusée → 409 PaymentDeclined', `${declined.status} ${declined.body?.error}`)
    const retry = await call('POST', `/api/v1/orders/${d.id}/delivery-completion-sessions/${s1.body.sessionId}/retry-payment`, {})
    check(retry.status === 200 && retry.body?.payment?.id !== p1.id, 'A: nouvelle tentative = nouveau paiement sans ressaisir le code', `${retry.status}`)
    await authorizeWithSimulatedReader(ACC.A, retry.body.payment.terminalLocationId, await piIdOf(retry.body.payment.id), '4242424242424242')
    const ok2 = await call('POST', `/api/v1/orders/${d.id}/delivery-completion-sessions/${s1.body.sessionId}/finalize`, { paymentId: retry.body.payment.id })
    check(ok2.status === 200 && ok2.body?.status === 'completed', 'A: 2e tentative acceptée → COMPLETED', `${ok2.status}`)
    const attempts = (await pool.query('select attempt_no, status from order_cash_on_delivery_payments where order_id = $1 order by attempt_no', [d.id])).rows
    check(attempts.length === 2 && attempts[0].status === 'failed' && attempts[1].status === 'captured', 'A: 2 tentatives (failed puis captured)', JSON.stringify(attempts))

    console.log('\n=== Contamination A/B : finalize avec le paiement d\'un autre restaurant ===')
    const oa = await newCollectedOrder('A'); const ob = await newCollectedOrder('B')
    const sa = await call('POST', `/api/v1/orders/${oa.id}/delivery-completion-sessions`, { expectedVersion: oa.version, deliveryCode: oa.code, readerFamily: 'simulated_bluetooth' })
    const sb = await call('POST', `/api/v1/orders/${ob.id}/delivery-completion-sessions`, { expectedVersion: ob.version, deliveryCode: ob.code, readerFamily: 'simulated_bluetooth' })
    await authorizeWithSimulatedReader(ACC.A, sa.body.payment.terminalLocationId, await piIdOf(sa.body.payment.id), '4242424242424242')
    const cross = await call('POST', `/api/v1/orders/${ob.id}/delivery-completion-sessions/${sb.body.sessionId}/finalize`, { paymentId: sa.body.payment.id })
    const stillCollected = (await pool.query('select status from orders where id = $1', [ob.id])).rows[0]?.status
    check(cross.status >= 400 && stillCollected === 'COLLECTED', 'B: finalize avec le paiement de A refusé, commande B intacte', `${cross.status} ${cross.body?.error} statut=${stillCollected}`)
    const noPay = await call('POST', `/api/v1/orders/${ob.id}/delivery-completion-sessions/${sb.body.sessionId}/finalize`, { paymentId: sb.body.payment.id })
    check(noPay.status === 409 && (await pool.query('select status from orders where id = $1', [ob.id])).rows[0]?.status === 'COLLECTED', 'B: finalize sans encaissement refusé, commande non terminée', `${noPay.status} ${noPay.body?.error}`)
  } finally {
    await app.close()
  }
}

async function piIdOf(paymentId: string): Promise<string> {
  return (await pool.query('select stripe_payment_intent_id from order_cash_on_delivery_payments where id = $1', [paymentId])).rows[0].stripe_payment_intent_id as string
}

async function cleanup(): Promise<void> {
  const { deleteTestOrders } = await import('../../apps/api/test/support/cleanup-orders.js')
  await deleteTestOrders(pool, createdOrders.splice(0))
  for (const id of Object.values(MERCHANT)) {
    await pool.query('delete from merchant_terminal_locations where merchant_id = $1', [id])
    await pool.query('delete from merchant_stripe_connect where merchant_id = $1', [id])
    await pool.query('delete from merchant_payment_profiles where merchant_id = $1', [id])
    await pool.query('delete from merchants where id = $1', [id])
  }
}

let exitCode = 0
try { await main() } catch (e) { exitCode = 1; console.error('ERREUR E2E:', e instanceof Error ? `${e.name}: ${e.message}` : e) }
try { await cleanup() } catch (e) { exitCode = 1; console.error('ERREUR nettoyage:', e instanceof Error ? e.message : e) }
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} vérifications OK${failed.length ? ` — ÉCHECS: ${failed.map((f) => f.check).join(' | ')}` : ''}`)
await pool.end()
process.exit(exitCode !== 0 || failed.length > 0 ? 1 : 0)
