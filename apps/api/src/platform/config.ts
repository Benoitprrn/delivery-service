import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

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
  OPENCAGE_API_KEY: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1)
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
