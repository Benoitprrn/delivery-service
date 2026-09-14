import type { Pool } from 'pg'
import { inTransaction } from './transaction.js'

export type OutboxEventToEmit = {
  eventType: string
  payload: Record<string, unknown>
}

export type OutboxEmit = (event: OutboxEventToEmit) => Promise<void> | void

type OutboxEventRow = {
  id: string
  event_type: string
  aggregate_id: string
  payload: Record<string, unknown>
  correlation_id: string
}

/**
 * Publie un lot d'événements sans tenir compte du résultat des autres lignes.
 *
 * Le verrou est conservé avec les mises à jour dans une même transaction : en
 * cas d'arrêt du processus avant le COMMIT, PostgreSQL libère le verrou et la
 * ligne reste non publiée pour le cycle suivant. Avec FOR UPDATE SKIP LOCKED,
 * plusieurs relais concurrents ne prennent jamais la même ligne en parallèle.
 */
export async function processOutboxBatch(pool: Pool, emit: OutboxEmit): Promise<void> {
  await inTransaction(pool, async (client) => {
    const result = await client.query<OutboxEventRow>(
      `select id, event_type, aggregate_id, payload, correlation_id
       from outbox_event
       where published_at is null
       order by created_at asc, id asc
       limit 10
       for update skip locked`
    )

    for (const outboxEvent of result.rows) {
      try {
        await emit({ eventType: outboxEvent.event_type, payload: outboxEvent.payload })
        await client.query('update outbox_event set published_at = now() where id = $1', [outboxEvent.id])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await client.query(
          'update outbox_event set attempts = attempts + 1, last_error = $2 where id = $1',
          [outboxEvent.id, message]
        )
      }
    }
  })
}

export function startOutboxRelay(pool: Pool, emit: OutboxEmit, intervalMs = 2_000): () => void {
  let processing = false

  const run = async (): Promise<void> => {
    if (processing) {
      return
    }

    processing = true
    try {
      await processOutboxBatch(pool, emit)
      // Proof assets are a short-lived dispute aid, not a durable document store.
      await pool.query('delete from order_proof_assets where expires_at <= now()')
      await pool.query('delete from driver_locations where expires_at <= now()')
    } catch {
      // Le prochain cycle réessaiera les lignes non publiées.
    } finally {
      processing = false
    }
  }

  const interval = setInterval(() => {
    void run()
  }, intervalMs)

  return () => clearInterval(interval)
}
