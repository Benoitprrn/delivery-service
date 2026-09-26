import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

const optionalNonBlank = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(1).optional()
)

// .env vit à la racine du monorepo (un seul fichier partagé, cf. Étape 1).
// npm exécute les scripts de workspace avec cwd = apps/api, donc la racine
// est à ../../ depuis là. N'écrase jamais une variable déjà présente dans
// l'environnement réel (comportement par défaut de dotenv).
loadDotenv({ path: path.resolve(process.cwd(), '../../.env') })

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  OSRM_URL: z.string().min(1),
  VROOM_URL: z.string().min(1),
  OPENCAGE_API_KEY: z.string().min(1),
  INSEE_API_KEY: optionalNonBlank,
  STRIPE_PAYMENTS_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  STRIPE_SECRET_KEY: optionalNonBlank,
  STRIPE_WEBHOOK_SECRET: optionalNonBlank,
  // Secret(s) de signature de l'endpoint webhook Connect (Direct Charge COD).
  // Facultatif : absent (ou vide), la route Connect répond 503 et son worker
  // n'est pas démarré, sans jamais empêcher le démarrage de l'API.
  STRIPE_CONNECT_WEBHOOK_SECRET: optionalNonBlank,
  STRIPE_ACCOUNTS_V2_API_VERSION: optionalNonBlank,
  WEB_APP_URL: z.string().url().default('http://localhost:3001'),
  // Worker de clôture hebdomadaire du règlement livreurs (R40) : DÉSACTIVÉ par défaut ; sans `go_live_at` posé il ne fait de toute façon rien.
  SETTLEMENT_CLOSE_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Pré-notification SEPA du lundi (R41, e-mail Locadely via Resend) : DÉSACTIVÉE par défaut ; activée, elle exige les quatre valeurs ci-dessous.
  SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Prélèvement SEPA du mercredi (R50) : DÉSACTIVÉ par défaut ; exige les secrets Stripe (STRIPE_PAYMENTS_ENABLED=true).
  SETTLEMENT_DEBIT_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Paiement des livreurs (R60) : DÉSACTIVÉ par défaut ; exige les secrets Stripe (STRIPE_PAYMENTS_ENABLED=true).
  SETTLEMENT_PAYOUT_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Exécution des reversals APPROUVÉES de Transfers livreurs (R61) : DÉSACTIVÉE par défaut ; exige les secrets Stripe.
  SETTLEMENT_REVERSAL_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Remboursements automatiques des frais de service après une reversal `driver_fault` réussie : DÉSACTIVÉS par défaut ; exigent Stripe.
  SETTLEMENT_SERVICE_REFUND_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Webhooks plateforme du règlement (journal + traitement) et réconciliation quotidienne (R70) : DÉSACTIVÉS par défaut ; exigent Stripe activé.
  SETTLEMENT_WEBHOOK_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SETTLEMENT_RECONCILIATION_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  // Identité légale du restaurant débiteur visible du livreur (R80, mise en demeure) : DÉSACTIVÉ par défaut ; base RGPD/contrat à valider AVANT toute production (checklist LEG-11).
  SETTLEMENT_DRIVER_SEES_DEBTOR_IDENTITY: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  RESEND_API_KEY: optionalNonBlank,
  RESEND_FROM_EMAIL: optionalNonBlank,
  SEPA_CREDITOR_ID: optionalNonBlank,
  SETTLEMENT_SUPPORT_EMAIL: optionalNonBlank,
  TERMINAL_ALLOW_SIMULATED_READER: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  // Plain 8-4-4-4-12 hex shape, not Zod's RFC4122-strict `.uuid()`: this
  // codebase's seed/fixture ids (e.g. zones' 11111111-…) set version/variant
  // nibbles Postgres itself never validates, and Zod's strict check rejects.
  DRIVER_SIGNUP_ZONE_ID: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  VALKEY_URL: z.string().min(1),
  DISPATCH_OFFER_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  PGBOSS_DATABASE_URL: z.string().min(1),
  // Connecteur SUPER PDP (Étape 5, docs/work/invoicing-preparation-plan.md §9-§10) : DÉSACTIVÉ
  // par défaut, aucun secret exigé ni appel réseau possible tant que non activé explicitement
  // (même patron que STRIPE_PAYMENTS_ENABLED). Un seul host connu (aucune URL sandbox distincte
  // dans la spec) : la distinction sandbox/production se fait par les identifiants OAuth utilisés,
  // jamais par une bascule d'URL en dur.
  SUPERPDP_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SUPERPDP_API_BASE_URL: z.string().url().default('https://api.superpdp.tech'),
  SUPERPDP_CLIENT_ID: optionalNonBlank,
  SUPERPDP_CLIENT_SECRET: optionalNonBlank,
  // Schéma d'adresse électronique EN16931 (BT-34) — hypothèse Peppol France par SIREN, NON
  // confirmée par la spec JSON (ADR 0007 §3) : configurable pour pouvoir corriger sans migration
  // si le sandbox la rejette.
  SUPERPDP_ELECTRONIC_ADDRESS_SCHEME: z.string().min(1).default('0225'),
  SUPERPDP_MANDATE_GRANTOR_NUMBER_SCHEME: z.enum(['fr_siren', 'sandbox']).default('fr_siren'),
  // Workers du connecteur, chacun DÉSACTIVÉ par défaut, indépendants les uns des autres.
  SUPERPDP_MANDATE_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SUPERPDP_SUBMISSION_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SUPERPDP_POLLING_WORKER_ENABLED: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.enum(['true', 'false']).default('false')
  ).transform((value) => value === 'true'),
  SUPERPDP_SUBMISSION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  SUPERPDP_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300)
}).superRefine((env, ctx) => {
  if (env.SUPERPDP_ENABLED && (env.SUPERPDP_CLIENT_ID === undefined || env.SUPERPDP_CLIENT_SECRET === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'SUPER PDP is enabled but SUPERPDP_CLIENT_ID or SUPERPDP_CLIENT_SECRET is missing' })
  }
  if ((env.SUPERPDP_MANDATE_WORKER_ENABLED || env.SUPERPDP_SUBMISSION_WORKER_ENABLED || env.SUPERPDP_POLLING_WORKER_ENABLED) && !env.SUPERPDP_ENABLED) {
    ctx.addIssue({ code: 'custom', message: 'A SUPER PDP worker is enabled but SUPERPDP_ENABLED is false' })
  }
  if (env.SETTLEMENT_PRE_NOTIFICATION_WORKER_ENABLED && (env.RESEND_API_KEY === undefined || env.RESEND_FROM_EMAIL === undefined || env.SEPA_CREDITOR_ID === undefined || env.SETTLEMENT_SUPPORT_EMAIL === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Settlement pre-notification is enabled but RESEND_API_KEY, RESEND_FROM_EMAIL, SEPA_CREDITOR_ID or SETTLEMENT_SUPPORT_EMAIL is missing' })
  }
  if ((env.SETTLEMENT_WEBHOOK_WORKER_ENABLED || env.SETTLEMENT_RECONCILIATION_WORKER_ENABLED) && (!env.STRIPE_PAYMENTS_ENABLED || env.STRIPE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Settlement webhook/reconciliation workers are enabled but Stripe payments are not enabled or the secret key is missing' })
  }
  if (env.SETTLEMENT_REVERSAL_WORKER_ENABLED && (!env.STRIPE_PAYMENTS_ENABLED || env.STRIPE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Driver reversal worker is enabled but Stripe payments are not enabled or the secret key is missing' })
  }
  if (env.SETTLEMENT_SERVICE_REFUND_WORKER_ENABLED && (!env.STRIPE_PAYMENTS_ENABLED || env.STRIPE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Service refund worker is enabled but Stripe payments are not enabled or the secret key is missing' })
  }
  if (env.SETTLEMENT_PAYOUT_WORKER_ENABLED && (!env.STRIPE_PAYMENTS_ENABLED || env.STRIPE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Driver payout worker is enabled but Stripe payments are not enabled or the secret key is missing' })
  }
  if (env.SETTLEMENT_DEBIT_WORKER_ENABLED && (!env.STRIPE_PAYMENTS_ENABLED || env.STRIPE_SECRET_KEY === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'SEPA debit worker is enabled but Stripe payments are not enabled or the secret key is missing' })
  }
  if (env.STRIPE_PAYMENTS_ENABLED && (env.STRIPE_SECRET_KEY === undefined || env.STRIPE_WEBHOOK_SECRET === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Stripe payments are enabled but Stripe credentials are missing' })
  }
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`)
  }
  return parsed.data
}

export const config = loadConfig()
