/**
 * S5bis — capability `cartes_bancaires_payments` sur comptes `dashboard=full` (Sandbox, jetables, NE PAS LIVRER).
 * E1 : compte neuf : ajout merchant full/stripe/stripe AVEC card_payments + cartes_bancaires_payments.
 * E2 : compte POC A (déjà onboardé, card_payments active) : demande a posteriori de cartes_bancaires_payments.
 */
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'
process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused', stripe)
const accounts = (stripe.v2.core as any).accounts
const err = (e: any): any => ({ ERROR: true, code: e?.code ?? e?.raw?.code, param: e?.param ?? e?.raw?.param, message: String(e?.message ?? e).slice(0, 240) })
const caps = (a: any) => ({ card_payments: a.configuration?.merchant?.capabilities?.card_payments, cartes_bancaires: a.configuration?.merchant?.capabilities?.cartes_bancaires_payments, reqs: (a.requirements?.entries ?? []).length })
async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { console.log(`\n## ${name}\n${JSON.stringify(await fn(), null, 1)}`) } catch (e) { console.log(`\n## ${name}\n${JSON.stringify(err(e))}`) }
}
async function main(): Promise<void> {
  await run('E1 compte neuf + card_payments + cartes_bancaires_payments', async () => {
    const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
    if (FORBIDDEN.has(id)) throw new Error('interdit')
    await provider.updateCustomerAccount(id, { email: 'cb@example.com', legalName: 'CB Test SARL', address: { line1: '1 Rue de la République', line2: '', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' } })
    const a = await accounts.update(id, {
      dashboard: 'full', defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true }, cartes_bancaires_payments: { requested: true } } } },
      include: ['configuration.merchant', 'requirements']
    })
    return { id, ...caps(a) }
  })
  const state = JSON.parse((await import('node:fs')).readFileSync(process.argv[2]!, 'utf8')) as { createdBy?: string; A?: string }
  if (state.createdBy !== 's1c' || !state.A || FORBIDDEN.has(state.A)) { console.error('état invalide'); return }
  await run('E2 compte A (card_payments active) : demande cartes_bancaires_payments', async () => {
    const before = caps(await accounts.retrieve(state.A, { include: ['configuration.merchant', 'requirements'] }))
    const a = await accounts.update(state.A, { configuration: { merchant: { capabilities: { cartes_bancaires_payments: { requested: true } } } }, include: ['configuration.merchant', 'requirements'] })
    return { before, after: caps(a) }
  })
  await run('E2b A après 3 s', async () => {
    await new Promise((r) => setTimeout(r, 3000))
    return caps(await accounts.retrieve(state.A, { include: ['configuration.merchant', 'requirements'] }))
  })
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
