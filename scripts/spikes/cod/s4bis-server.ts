/**
 * S4bis (serveur) — robustesse Direct Charge avec lecteur simulé PILOTÉ PAR L'API (server-driven, Sandbox, NE PAS LIVRER).
 * Vrais objets Stripe (PI, capture, comptes connectés A/B) ; seul le matériel est simulé (registration_code simulated-s700).
 * T1 double capture (même clé / autre clé) · T2 capture sous le mauvais compte · T3 annulation après capture
 * T4 carte refusée puis annulation · T5 capture concurrente · T6 montant capturé = montant du PI
 */
import { existsSync, readFileSync } from 'node:fs'
import Stripe from 'stripe'
process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const st = process.argv[2]
if (!st || !existsSync(st)) { console.error('état requis'); process.exit(1) }
const saved = JSON.parse(readFileSync(st, 'utf8')) as { createdBy?: string; A?: string; B?: string }
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
if (saved.createdBy !== 's1c' || !saved.A || !saved.B || saved.A === saved.B || FORBIDDEN.has(saved.A) || FORBIDDEN.has(saved.B)) { console.error('état invalide'); process.exit(1) }
const A = saved.A, B = saved.B
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 0 })
const err = (e: any) => ({ code: e?.code ?? e?.raw?.code, type: e?.type, message: String(e?.message).slice(0, 140) })
const out: Record<string, unknown> = {}
const step = async (n: string, f: () => Promise<unknown>) => { try { out[n] = await f() } catch (e) { out[n] = { ERROR: err(e) } } console.log(`\n## ${n}\n${JSON.stringify(out[n], null, 1)}`) }

async function readerFor(account: string): Promise<{ reader: string; location: string }> {
  const locs = await stripe.terminal.locations.list({ limit: 20 }, { stripeAccount: account })
  const loc = locs.data.find((l) => l.display_name === 'COD POC Bourg-en-Bresse') ?? locs.data[0]
  if (!loc) throw new Error('pas de Location')
  const rs = await stripe.terminal.readers.list({ location: loc.id, limit: 10 }, { stripeAccount: account })
  const r = rs.data.find((x) => x.device_type === 'simulated_stripe_s700') ?? await stripe.terminal.readers.create({ registration_code: 'simulated-s700', location: loc.id, label: 'S4bis simulé' }, { stripeAccount: account })
  return { reader: r.id, location: loc.id }
}
async function authorized(account: string, reader: string, card = '4242424242424242'): Promise<Stripe.PaymentIntent> {
  const pi = await stripe.paymentIntents.create({ amount: 5000, currency: 'eur', payment_method_types: ['card_present'], capture_method: 'manual', metadata: { spike: 's4bis' } }, { stripeAccount: account })
  await stripe.terminal.readers.processPaymentIntent(reader, { payment_intent: pi.id }, { stripeAccount: account })
  await (stripe.testHelpers.terminal.readers as any).presentPaymentMethod(reader, { type: 'card_present', card_present: { number: card } }, { stripeAccount: account })
  for (let i = 0; i < 10; i++) {
    const cur = await stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })
    if (['requires_capture', 'succeeded', 'requires_payment_method', 'canceled'].includes(cur.status)) return cur
    await new Promise((r) => setTimeout(r, 1000))
  }
  return stripe.paymentIntents.retrieve(pi.id, {}, { stripeAccount: account })
}

async function main(): Promise<void> {
  const ra = await readerFor(A)
  await step('T0 lecteur simulé serveur sur A', async () => ({ ok: true }))
  const pi1 = await authorized(A, ra.reader)
  await step('T1a PI 50 € autorisé (requires_capture)', async () => ({ id: pi1.id, status: pi1.status, amount: pi1.amount, amount_capturable: pi1.amount_capturable }))
  await step('T1b capture #1 (clé K1)', async () => { const p = await stripe.paymentIntents.capture(pi1.id, {}, { stripeAccount: A, idempotencyKey: `s4bis-${pi1.id}-K1` }); return { status: p.status, received: p.amount_received } })
  await step('T1c capture #2 MÊME clé K1 (rejeu idempotent)', async () => { const p = await stripe.paymentIntents.capture(pi1.id, {}, { stripeAccount: A, idempotencyKey: `s4bis-${pi1.id}-K1` }); return { status: p.status, received: p.amount_received } })
  await step('T1d capture #3 AUTRE clé K2 (double finalize sans idempotence)', async () => { const p = await stripe.paymentIntents.capture(pi1.id, {}, { stripeAccount: A, idempotencyKey: `s4bis-${pi1.id}-K2` }); return { status: p.status } })
  await step('T2 lecture du PI de A sous le compte B', async () => (await stripe.paymentIntents.retrieve(pi1.id, {}, { stripeAccount: B })).id)
  await step('T2b capture du PI de A sous le compte B', async () => (await stripe.paymentIntents.capture(pi1.id, {}, { stripeAccount: B })).status)
  await step('T3 annulation APRÈS capture', async () => (await stripe.paymentIntents.cancel(pi1.id, {}, { stripeAccount: A })).status)
  await step('T6 relecture : montant/frais/transfert', async () => { const p = await stripe.paymentIntents.retrieve(pi1.id, { expand: ['latest_charge'] }, { stripeAccount: A }); const c: any = p.latest_charge; return { amount: p.amount, received: p.amount_received, currency: p.currency, app_fee: p.application_fee_amount, transfer_data: p.transfer_data, on_behalf_of: p.on_behalf_of, captured: c?.captured, charge_amount: c?.amount, fee_details: 'voir balance_transaction' } })
  const pi2 = await authorized(A, ra.reader, '4000000000000002')
  await step('T4a carte REFUSÉE (…0002)', async () => ({ id: pi2.id, status: pi2.status, last_error: pi2.last_payment_error ? { code: pi2.last_payment_error.code, decline_code: pi2.last_payment_error.decline_code } : null }))
  await step('T4b annulation du PI refusé', async () => (await stripe.paymentIntents.cancel(pi2.id, {}, { stripeAccount: A })).status)
  const pi3 = await authorized(A, ra.reader)
  await step('T5 deux captures CONCURRENTES (clés différentes)', async () => {
    const r = await Promise.allSettled([
      stripe.paymentIntents.capture(pi3.id, {}, { stripeAccount: A, idempotencyKey: `s4bis-${pi3.id}-c1` }),
      stripe.paymentIntents.capture(pi3.id, {}, { stripeAccount: A, idempotencyKey: `s4bis-${pi3.id}-c2` })
    ])
    return r.map((x) => x.status === 'fulfilled' ? { ok: (x.value as any).status } : { ERROR: err((x as any).reason) })
  })
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
