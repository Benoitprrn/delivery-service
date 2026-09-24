import type { Pool } from 'pg'

const INVOICE_TABLES_LOCK_KEY = 7_280_047

/**
 * `invoices`/`invoice_lines`/`credit_notes`/`credit_note_lines`/`invoice_number_sequences`/
 * `invoice_provider_submissions`/`einvoice_events` sont append-only : seul `TRUNCATE` peut les
 * nettoyer entre deux tests (contourne les triggers `BEFORE DELETE`, cf. r47-testdb.sh). Plusieurs
 * fichiers de test tournent en parallèle sur la même base isolée (vitest par défaut) — sans
 * verrou, un `TRUNCATE` d'un fichier efface les lignes qu'un autre fichier est en train
 * d'utiliser. Même mécanique que `lockSettlementSingleton` : verrou consultatif tenu par une
 * connexion dédiée pour toute la durée du fichier.
 */
export async function lockInvoiceTables(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect()
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [INVOICE_TABLES_LOCK_KEY])
    if (rows[0]!.locked) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return async () => {
    try {
      await client.query('select pg_advisory_unlock($1)', [INVOICE_TABLES_LOCK_KEY])
    } finally {
      client.release()
    }
  }
}
