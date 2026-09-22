import type { Pool } from 'pg'

const FIXTURE_LOCK_KEY = 7_280_001

/**
 * Vitest exécute les fichiers en parallèle sur la même base : deux fichiers qui pilotent le même
 * commerçant/livreur de la seed se marchent dessus. Ce verrou consultatif (tenu par une connexion
 * dédiée pour toute la durée du fichier) les sérialise sans ralentir le reste de la suite.
 */
export async function lockSeedFixture(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect()
  // Le pool impose un statement_timeout : on sonde au lieu de bloquer dans pg_advisory_lock.
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [FIXTURE_LOCK_KEY])
    if (rows[0]!.locked) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return async () => {
    try {
      await client.query('select pg_advisory_unlock($1)', [FIXTURE_LOCK_KEY])
    } finally {
      client.release()
    }
  }
}
