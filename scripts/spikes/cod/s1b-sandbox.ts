/**
 * S1b — suite du spike jetable (Sandbox uniquement, NE PAS LIVRER).
 * F1 : préremplir sur compte customer-only PUIS ajouter merchant → requirements restants.
 * F2 : matrice des champs modifiables via API APRÈS merchant (FR = account_token_required ?).
 * F3 : account link v2 avec configurations ['customer','merchant'].
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import Stripe from 'stripe'
import { StripeApiProvider } from '../../../apps/api/src/modules/payments/infrastructure/stripe-provider.js'

process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const outIndex = process.argv.indexOf('--out')
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const provider = new StripeApiProvider(key, 'whsec_unused_in_spike', stripe)
const accounts = (stripe.v2.core as any).accounts
const INCLUDE = ['configuration.customer', 'configuration.merchant', 'defaults', 'identity', 'requirements']
const results: Record<string, unknown> = {}

function err(e: any): Record<string, unknown> {
  if (e?.cause) return { ...err(e.cause), wrappedBy: e?.constructor?.name }
  return { ERROR: true, code: e?.code ?? e?.raw?.code, param: e?.param ?? e?.raw?.param, message: String(e?.message ?? e).slice(0, 260), requestId: e?.requestId }
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { const v = await fn(); results[name] = v; console.log(`\n## ${name}\n${JSON.stringify(v, null, 1)}`); return v }
  catch (e) { results[name] = err(e); console.log(`\n## ${name}\n${JSON.stringify(results[name], null, 1)}`); return undefined }
}
function reqs(a: any): Record<string, unknown> {
  const entries = a?.requirements?.entries ?? []
  return {
    id: a?.id, dashboard: a?.dashboard, applied: a?.applied_configurations,
    card_payments: a?.configuration?.merchant?.capabilities?.card_payments?.status,
    count: entries.length,
    keys: entries.map((e: any) => e?.description ?? e?.reference ?? e?.id)
  }
}
const details = { email: 'spike-cod-b@example.com', legalName: 'Spike COD B SARL', address: { line1: '1 Rue de la République', line2: 'Bât. A', city: 'Bourg-en-Bresse', postalCode: '01000', countryCode: 'FR' } }

async function main(): Promise<void> {
  // F1 — préremplissage avant merchant
  const f1 = await step('F1 prefill customer-only puis add merchant', async () => {
    const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
    await provider.updateCustomerAccount(id, details)
    const prefill: Record<string, unknown> = {}
    for (const [label, body] of Object.entries({
      phone: { identity: { business_details: { phone: '+33474000000' } } },
      siren: { identity: { business_details: { id_numbers: [{ type: 'fr_siren', registered_number: '123456789' }] } } },
      profile: { defaults: { profile: { business_url: 'https://example.com', product_description: 'Restaurant', doing_business_as: 'Spike Resto' } } },
      contact_phone: { contact_phone: '+33474000000' }
    })) {
      try { await accounts.update(id, body); prefill[label] = 'ok' } catch (e) { prefill[label] = err(e) }
    }
    const added = await accounts.update(id, {
      dashboard: 'full',
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { merchant: { mcc: '5812', support: { phone: '+33474000000' }, capabilities: { card_payments: { requested: true } } } },
      include: INCLUDE
    })
    return { id, prefill, after: reqs(added) }
  }) as { id: string } | undefined
  if (f1 === undefined) return

  // F2 — champs modifiables APRÈS merchant
  const attempts: Record<string, Record<string, unknown>> = {
    contact_email: { contact_email: 'changed@example.com' },
    display_name: { display_name: 'Spike renamed' },
    contact_phone: { contact_phone: '+33474000001' },
    profile_business_url: { defaults: { profile: { business_url: 'https://example.org' } } },
    registered_name: { identity: { business_details: { registered_name: 'Spike Renamed SARL' } } },
    address_line1: { identity: { business_details: { address: { line1: '9 Rue Neuve' } } } },
    address_full_like_sepa: { identity: { country: 'fr', entity_type: 'company', business_details: { registered_name: details.legalName, address: { line1: details.address.line1, line2: details.address.line2, city: details.address.city, postal_code: details.address.postalCode, country: 'fr' } } } },
    entity_type_only: { identity: { entity_type: 'company' } },
    business_phone: { identity: { business_details: { phone: '+33474000002' } } }
  }
  const matrix: Record<string, unknown> = {}
  for (const [label, body] of Object.entries(attempts)) {
    try { await accounts.update((f1 as any).id, body); matrix[label] = 'ok' } catch (e) { matrix[label] = err(e) }
  }
  await step('F2 matrice post-merchant (update via API)', async () => matrix)

  // F3 — account link
  for (const configs of [['customer', 'merchant'], ['merchant']]) {
    await step(`F3 account link configs=${configs.join('+')}`, async () => {
      const link = await (stripe.v2.core as any).accountLinks.create({
        account: (f1 as any).id,
        use_case: { type: 'account_onboarding', account_onboarding: { configurations: configs, return_url: 'https://example.com/return', refresh_url: 'https://example.com/refresh' } }
      })
      return { host: new URL(link.url).host, expires_at: link.expires_at }
    })
  }

  // F4 — lien sur compte customer-only : peut-on demander ['merchant'] avant l'ajout ?
  await step('F4 account link merchant sur compte customer-only (avant ajout)', async () => {
    const { id } = await provider.createCustomerAccount({ merchantId: randomUUID() })
    await provider.updateCustomerAccount(id, details)
    const link = await (stripe.v2.core as any).accountLinks.create({
      account: id, use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], return_url: 'https://example.com/return', refresh_url: 'https://example.com/refresh' } }
    })
    return { host: new URL(link.url).host, id }
  })
  if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2))
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
