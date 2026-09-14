import type { Pool, PoolClient } from 'pg'

export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  let began = false
  // Ne marque la connexion pour destruction que si son état devient
  // réellement incertain (ROLLBACK échoué, ou BEGIN jamais entré en vigueur).
  // Une erreur métier ordinaire (ex. OrderConflictError) suivie d'un ROLLBACK
  // réussi laisse la connexion parfaitement réutilisable — la détruire à
  // chaque conflit d'assignation reviendrait à recycler le pool en continu.
  let releaseError: Error | undefined

  try {
    await client.query('BEGIN')
    began = true
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error
            ? rollbackError
            : new Error('Transaction rollback failed', { cause: rollbackError })
      }
    } else {
      releaseError = error instanceof Error ? error : new Error('Transaction begin failed', { cause: error })
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}
