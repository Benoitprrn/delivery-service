import type { Pool } from 'pg'

const SETTLEMENT_SINGLETON_LOCK_KEY = 7_280_002

/**
 * `settlement_settings` (go_live_at) est un singleton partagé : les fichiers de test qui le modifient ou clôturent des périodes
 * ne doivent pas tourner en même temps (vitest exécute les fichiers en parallèle sur la même base). Verrou consultatif tenu par
 * une connexion dédiée pour toute la durée du fichier (même mécanique que `lockSeedFixture`).
 */
export async function lockSettlementSingleton(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect()
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [SETTLEMENT_SINGLETON_LOCK_KEY])
    if (rows[0]!.locked) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return async () => {
    try {
      await client.query('select pg_advisory_unlock($1)', [SETTLEMENT_SINGLETON_LOCK_KEY])
    } finally {
      client.release()
    }
  }
}
