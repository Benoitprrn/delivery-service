/**
 * S1f — revalidation APRÈS onboarding (KYC) sur les comptes POC A et B (Sandbox, NE PAS LIVRER).
 *   npx tsx scripts/spikes/cod/s1f-post-kyc.ts --state <poc-accounts.json>
 * F1 statut (card_payments, requirements) ; F2 matrice d'updates API post-KYC ; F3 account_token (test) ;
 * F4 parcours SEPA T23 : hasMerchantConfiguration → pas d'update → SetupIntent → confirmation IBAN test → mandat ;
 * F5 le provider RÉEL : updateCustomerAccount post-merchant (doit lever StripeAccountTokenRequiredError).
 * Ne modifie pas d'autre compte que A/B (gardes), n'affiche aucune URL.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'
import { StripeAccountTokenRequiredError } from '../../../apps/api/src/modules/payments/ports/stripe-provider.js'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const stateArg = process.argv[process.argv.indexOf('--state') + 1]
if (!stateArg || !existsSync(stateArg)) { console.error('--state <fichier> requis'); process.exit(1) }
const saved = JSON.parse(readFileSync(stateArg, 'utf8')) as { createdBy?: string; A?: string; B?: string }
const FORBIDDEN = new Set(['acct_1UHTimJwc2CYzaPJ'])
if (saved.createdBy !== 's1c' || !saved.A || !saved.B || saved.A === saved.B || [saved.A, saved.B].some((i) => FORBIDDEN.has(i))) { console.error('État invalide.'); process.exit(1) }
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused_in_spike', stripe)
const accounts = (stripe.v2.core as any).accounts
const err = (e: any): any => ({ ERROR: true, code: e?.code ?? e?.raw?.code, param: e?.param ?? e?.raw?.param, message: String(e?.message ?? e).slice(0, 200) })
const details = { email: 'poc-postkyc@example.com', legalName: 'POC Post KYC SARL', address: { line1: '5 Rue Neuve', line2: '', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' } }

async function one(label: 'A' | 'B', id: string): Promise<void> {
  const out: Record<string, unknown> = { label, id }
  const a = await accounts.retrieve(id, { include: ['configuration.merchant', 'configuration.customer', 'defaults', 'requirements', 'identity'] })
  out.F1 = {
    livemode: a.livemode, dashboard: a.dashboard, applied: a.applied_configurations, resp: a.defaults?.responsibilities,
    card_payments: a.configuration?.merchant?.capabilities?.card_payments,
    reqs: (a.requirements?.entries ?? []).map((e: any) => e.description ?? e.reference ?? e.id),
    closed: a.closed, tosAccepted: a.identity?.attestations?.terms_of_service?.account ?? null
  }
  const attempts: Record<string, any> = {
    contact_email: { contact_email: `changed-${label}@example.com` }, display_name: { display_name: `POC ${label} renamed` },
    contact_phone: { contact_phone: '+33474000001' },
    registered_name: { identity: { business_details: { registered_name: `POC ${label} Renamed SARL` } } },
    address_line1: { identity: { business_details: { address: { line1: '9 Rue Neuve' } } } },
    entity_type: { identity: { entity_type: 'company' } }
  }
  const matrix: Record<string, unknown> = {}
  for (const [k, body] of Object.entries(attempts)) { try { await accounts.update(id, body); matrix[k] = 'ok' } catch (e) { matrix[k] = err(e).code ?? err(e).message } }
  out.F2_updates_post_kyc = matrix
  try {
    const tok = await (stripe.v2.core as any).accountTokens.create({ display_name: `POC ${label} token` })
    const upd = await accounts.update(id, { account_token: tok.id })
    out.F3_account_token = { ok: true, display_name: upd.display_name }
  } catch (e) { out.F3_account_token = err(e) }
  try {
    out.F5_provider_updateCustomerAccount = await provider.updateCustomerAccount(id, details).then(() => 'AUCUNE ERREUR (inattendu)', (e) => e instanceof StripeAccountTokenRequiredError ? 'StripeAccountTokenRequiredError (attendu)' : `autre erreur: ${e?.cause?.code ?? e?.message}`)
  } catch (e) { out.F5_provider_updateCustomerAccount = err(e) }
  try {
    const merchant = await provider.hasMerchantConfiguration(id)
    const skipped = merchant ? 'update ignoré (option A)' : 'update exécuté'
    const si = await provider.createSetupIntent({ customerAccountId: id, merchantId: randomUUID() })
    const done = await stripe.setupIntents.confirm(si.setupIntentId, {
      payment_method_data: { type: 'sepa_debit', sepa_debit: { iban: 'FR1420041010050500013M02606' }, billing_details: { name: `PAYEUR POST KYC ${label}`, email: `payeur-${label}@example.com`, address: { line1: '9 Rue B', city: 'Lyon', postal_code: '69001', country: 'FR' } } },
      mandate_data: { customer_acceptance: { type: 'online', online: { ip_address: '203.0.113.7', user_agent: 's1f' } } }
    })
    out.F4_sepa = { hasMerchant: merchant, skipped, setupIntent: done.status, mandate: typeof done.mandate === 'string' }
  } catch (e) { out.F4_sepa = err(e) }
  console.log(`\n## ${label}\n${JSON.stringify(out, null, 1)}`)
}
async function main(): Promise<void> {
  await one('A', saved.A!)
  await one('B', saved.B!)
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
