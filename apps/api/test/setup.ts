import { afterAll } from 'vitest'

// The Auth Admin adapter is wired in every app instance. Tests do not call the
// external provider unless explicitly mocked, but configuration remains strict
// outside the test runtime. Skipped under the mandate sandbox opt-in (Tranche 4d,
// `test/invoices/mandate-workflow-sandbox.test.ts`), which needs the REAL Supabase Storage
// service key from `.env` (Storage always runs on the hosted project, never locally) — same
// opt-in mechanism as `SUPERPDP_SANDBOX_TESTS` below: `dotenv` (loaded later, in `config.ts`)
// never overrides a `process.env` value already set here, so skipping this line is what lets the
// real `.env` value through for that one opt-in file.
if (process.env.SUPERPDP_SANDBOX_TESTS !== '1') {
  process.env.SUPABASE_SECRET_KEY ??= 'test-service-role-key'
}

// Les tests sont hors ligne par contrat : même si le .env local porte des clés
// Stripe (Sandbox), aucun test ne doit pouvoir instancier le vrai provider ni
// démarrer le worker de paiements. Les tests payments emploient des fakes.
// Valeurs vides plutôt que `delete` : dotenv ne réécrit pas une variable déjà
// présente, alors qu'il repeuplerait une variable absente depuis .env.
process.env.STRIPE_PAYMENTS_ENABLED = 'false'
process.env.STRIPE_SECRET_KEY = ''
process.env.STRIPE_WEBHOOK_SECRET = ''
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = ''

// Même contrat hors ligne pour le connecteur SUPER PDP (Étape 5) : même si le .env local porte
// de vraies clés sandbox, aucun test ne doit pouvoir appeler le vrai fournisseur — SAUF le test
// sandbox opt-in dédié (`test/invoices/superpdp-sandbox.test.ts`), qui a justement besoin des
// vraies valeurs du `.env` et se déclare lui-même via `SUPERPDP_SANDBOX_TESTS=1` (jamais dans la
// suite normale `npm test`, jamais par défaut).
if (process.env.SUPERPDP_SANDBOX_TESTS !== '1') {
  process.env.SUPERPDP_ENABLED = 'false'
  process.env.SUPERPDP_CLIENT_ID = ''
  process.env.SUPERPDP_CLIENT_SECRET = ''
}

afterAll(async () => {
  const { pool } = await import('../src/platform/db.js')
  await pool.end()
})
