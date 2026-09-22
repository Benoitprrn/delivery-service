/**
 * S1e — isolation des causes (suite à la revue S2). Sandbox, comptes JETABLES neufs, NE PAS LIVRER.
 * E1 : corps MINIMAL (dashboard + responsabilités + merchant vide) — quelle combinaison est réellement invalide ?
 * E2 : préremplissage baseline/variant (mêmes paramètres) : SIREN {type,value}, URL réelle.
 * E3 : account link ['customer'] sur customer-only ; ['customer','merchant'] après ajout.
 * E4 : source du nom/e-mail du mandat SEPA : identité Account (A) vs billing_details du PaymentMethod (B).
 * Aucune URL d'onboarding n'est affichée (host + expiration seulement).
 */
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused_in_spike', stripe)
const accounts = (stripe.v2.core as any).accounts
const err = (e: any): any => ({ ERROR: true, code: e?.code ?? e?.raw?.code, param: e?.param ?? e?.raw?.param, message: String(e?.message ?? e).slice(0, 220) })
const base = { email: 'spike-e@example.com', legalName: 'Spike E SARL', address: { line1: '1 Rue de la République', line2: 'Bât. A', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' } }

async function fresh(label: string, over: Partial<typeof base> = {}): Promise<string> {
  const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
  if (FORBIDDEN.has(id)) throw new Error('compte interdit')
  await provider.updateCustomerAccount(id, { ...base, ...over, legalName: over.legalName ?? `${base.legalName} ${label}` })
  return id
}
async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { console.log(`\n## ${name}\n${JSON.stringify(await fn(), null, 1)}`) } catch (e) { console.log(`\n## ${name}\n${JSON.stringify(err(e))}`) }
}
const summ = (a: any) => ({ dashboard: a.dashboard, applied: a.applied_configurations, resp: a.defaults?.responsibilities, cp: a.configuration?.merchant?.capabilities?.card_payments?.status ?? null, reqs: (a.requirements?.entries ?? []).length })

async function main(): Promise<void> {
  // E1 — corps minimal : dashboard + responsabilités + merchant {} (sans capability, sans include)
  const combos: Array<[string, string, string]> = [
    ['full', 'stripe', 'stripe'], ['full', 'application', 'application'], ['full', 'application', 'stripe'], ['full', 'stripe', 'application'],
    ['none', 'stripe', 'stripe'], ['none', 'application', 'application'], ['none', 'application', 'stripe'], ['none', 'stripe', 'application'],
    ['express', 'application', 'application'], ['express', 'stripe', 'stripe']
  ]
  for (const [d, f, l] of combos) {
    await run(`E1 minimal dashboard=${d} fees=${f} losses=${l}`, async () => {
      const id = await fresh(`E1-${d}-${f}-${l}`)
      const body = { dashboard: d, defaults: { responsibilities: { fees_collector: f, losses_collector: l } }, configuration: { merchant: {} } }
      await accounts.update(id, body)
      return summ(await accounts.retrieve(id, { include: ['configuration.merchant', 'defaults', 'requirements'] }))
    })
  }

  // E2 — baseline vs variant de préremplissage (mêmes autres paramètres)
  const mk = async (label: string, prefill: any): Promise<any> => {
    const id = await fresh(label)
    const applied: any = {}
    for (const [k, body] of Object.entries(prefill)) { try { await accounts.update(id, body); applied[k] = 'ok' } catch (e) { applied[k] = err(e) } }
    await accounts.update(id, { dashboard: 'full', defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } }, configuration: { merchant: { mcc: '5812', support: { phone: '+33474000000' }, capabilities: { card_payments: { requested: true } } } } })
    const a = await accounts.retrieve(id, { include: ['configuration.merchant', 'defaults', 'requirements'] })
    return { applied, ...summ(a), keys: (a.requirements?.entries ?? []).map((e: any) => e.description ?? e.reference ?? e.id) }
  }
  const baseline = await mk('E2-baseline', {})
  const variant = await mk('E2-variant', {
    siren: { identity: { business_details: { id_numbers: [{ type: 'fr_siren', value: '123456789' }] } } },
    url: { defaults: { profile: { business_url: 'https://www.wikipedia.org' } } },
    desc: { defaults: { profile: { product_description: 'Restaurant de quartier, plats à emporter et livraison.' } } },
    phone: { identity: { business_details: { phone: '+33474000000' } } }
  })
  console.log('\n## E2 baseline', JSON.stringify({ ...baseline, keys: baseline.keys.length }))
  console.log('## E2 variant', JSON.stringify({ ...variant, keys: variant.keys.length, removed: baseline.keys.filter((k: string) => !variant.keys.includes(k)) }))

  // E3 — liens (host + expiration seulement)
  const linkOf = async (id: string, configs: string[]): Promise<unknown> => {
    const l = await (stripe.v2.core as any).accountLinks.create({ account: id, use_case: { type: 'account_onboarding', account_onboarding: { configurations: configs, return_url: 'https://example.com/return', refresh_url: 'https://example.com/refresh' } } })
    return { host: new URL(l.url).host, expires_at: l.expires_at }
  }
  await run('E3a lien [customer] sur customer-only', async () => linkOf(await fresh('E3a'), ['customer']))
  await run('E3b lien [customer,merchant] après ajout merchant', async () => {
    const id = await fresh('E3b')
    await accounts.update(id, { dashboard: 'full', defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } }, configuration: { merchant: {} } })
    return linkOf(id, ['customer', 'merchant'])
  })

  // E4 — identité Account (A) vs billing_details du PM (B) sur le mandat SEPA
  await run('E4 mandat SEPA : Account identité A, PaymentMethod billing B', async () => {
    const id = await fresh('IdentityA', { email: 'account-a@example.com', legalName: 'IDENTITE COMPTE A SARL' })
    const si = await provider.createSetupIntent({ customerAccountId: id, merchantId: randomUUID() })
    const done = await stripe.setupIntents.confirm(si.setupIntentId, {
      payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: 'FR1420041010050500013M02606' }, billing_details: { name: 'PAYEUR BILLING B', email: 'billing-b@example.com', address: { line1: '9 Rue B', city: 'Lyon', postal_code: '69001', country: 'FR' } } },
      mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '203.0.113.7', user_agent: 'spike-e4' } } }
    })
    const pm = await stripe.paymentMethods.retrieve(done.payment_method as string)
    const mandate: any = await stripe.mandates.retrieve(done.mandate as string)
    const url: string | undefined = mandate?.payment_method_details?.sepa_debit?.url
    let pdfNames: unknown = 'no url'
    if (url !== undefined) {
      const res = await fetch(url); const buf = Buffer.from(await res.arrayBuffer())
      const text = buf.toString('latin1')
      pdfNames = { status: res.status, bytes: buf.length, containsAccountA: text.includes('IDENTITE COMPTE A'), containsBillingB: text.includes('PAYEUR BILLING B'), isPdf: text.startsWith('%PDF') }
    }
    return { pmBilling: { name: pm.billing_details.name, email: pm.billing_details.email }, mandateStatus: mandate.status, hasUrl: url !== undefined, pdfNames }
  })
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
