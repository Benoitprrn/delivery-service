/**
 * S1d — account tokens v2 sur un compte JETABLE ayant déjà `merchant` (Sandbox, NE PAS LIVRER).
 * Question : après merchant, un update par `account_token` remplace-t-il l'update direct refusé
 * (`account_token_required`) ? Quels champs passent ? (en live, le token exige la clé publiable.)
 */
import Stripe from 'stripe'
process.loadEnvFile('.env')
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!/^(sk|rk)_test_/.test(key)) { console.error('Abandon : clé non Sandbox.'); process.exit(1) }
const target = process.argv[2]
if (!target?.startsWith('acct_')) { console.error('usage: s1d-account-token.ts acct_xxx'); process.exit(1) }
const stripe = new Stripe(key, { timeout: 30_000, maxNetworkRetries: 1 })
const core = (stripe.v2.core as any)
const err = (e: any): any => ({ ERROR: true, code: e?.code ?? e?.raw?.code, param: e?.param ?? e?.raw?.param, message: String(e?.message ?? e).slice(0, 300), requestId: e?.requestId })
const bodies: Record<string, any> = {
  T1_email_name: { contact_email: 'token-sync@example.com', display_name: 'Token Sync Name' },
  T2_identity: { identity: { entity_type: 'company', business_details: { registered_name: 'Token Sync SARL', address: { line1: '3 Rue du Token', city: 'Bourg-en-Bresse', postal_code: '01000', country: 'fr' } } } },
  T3_all_like_sepa: { contact_email: 'token-sync2@example.com', display_name: 'Token Sync SARL', identity: { entity_type: 'company', business_details: { registered_name: 'Token Sync SARL', address: { line1: '4 Rue du Token', line2: 'Bât. B', city: 'Bourg-en-Bresse', postal_code: '01000', country: 'fr' } } } }
}
async function main(): Promise<void> {
  for (const [label, body] of Object.entries(bodies)) {
    const out: any = {}
    try {
      const tok = await core.accountTokens.create(body)
      out.token = { created: true, used: tok.used, expires_at: tok.expires_at }
      try {
        const acc = await core.accounts.update(target, { account_token: tok.id, include: ['identity'] })
        out.update = { ok: true, display_name: acc.display_name, contact_email: acc.contact_email, registered_name: acc.identity?.business_details?.registered_name, line1: acc.identity?.business_details?.address?.line1, line2: acc.identity?.business_details?.address?.line2 }
      } catch (e) { out.update = err(e) }
    } catch (e) { out.token = err(e) }
    console.log(`\n## ${label}\n${JSON.stringify(out, null, 1)}`)
  }
}
main().catch((e) => { console.error(err(e)); process.exit(1) })
