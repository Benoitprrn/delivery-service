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
 * Le lot est réclamé dans une transaction courte : avec FOR UPDATE SKIP
 * LOCKED, plusieurs relais concurrents ne prennent jamais le même lot en
 * parallèle. Le bail locked_until protège chaque publication après le COMMIT,
 * sans conserver de transaction PostgreSQL durant l'appel réseau. En cas
 * d'arrêt, le bail expire et la ligne non publiée est reprise au cycle suivant.
 */
export async function processOutboxBatch(pool: Pool, emit: OutboxEmit): Promise<void> {
  const outboxEvents = await inTransaction(pool, async (client) => {
    const result = await client.query<OutboxEventRow>(
      `update outbox_event
       set locked_until = now() + interval '30 seconds'
       where id in (
         select id from outbox_event
         where published_at is null
           and (locked_until is null or locked_until < now())
         order by created_at asc, id asc
         limit 10
         for update skip locked
       )
       returning id, event_type, aggregate_id, payload, correlation_id`
    )
    return result.rows
  })

  for (const outboxEvent of outboxEvents) {
    try {
      await emit({ eventType: outboxEvent.event_type, payload: outboxEvent.payload })
      await inTransaction(pool, async (client) => {
        await client.query(
          'update outbox_event set published_at = now(), locked_until = null where id = $1 and published_at is null',
          [outboxEvent.id]
        )
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await inTransaction(pool, async (client) => {
        await client.query(
          'update outbox_event set attempts = attempts + 1, last_error = $2, locked_until = null where id = $1 and published_at is null',
          [outboxEvent.id, message]
        )
      })
    }
  }
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
