import { afterAll } from 'vitest'

// The Auth Admin adapter is wired in every app instance. Tests do not call the
// external provider unless explicitly mocked, but configuration remains strict
// outside the test runtime.
process.env.SUPABASE_SECRET_KEY ??= 'test-service-role-key'

// Les tests sont hors ligne par contrat : même si le .env local porte des clés
// Stripe (Sandbox), aucun test ne doit pouvoir instancier le vrai provider ni
// démarrer le worker de paiements. Les tests payments emploient des fakes.
// Valeurs vides plutôt que `delete` : dotenv ne réécrit pas une variable déjà
// présente, alors qu'il repeuplerait une variable absente depuis .env.
process.env.STRIPE_PAYMENTS_ENABLED = 'false'
process.env.STRIPE_SECRET_KEY = ''
process.env.STRIPE_WEBHOOK_SECRET = ''
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = ''

afterAll(async () => {
  const { pool } = await import('../src/platform/db.js')
  await pool.end()
})
