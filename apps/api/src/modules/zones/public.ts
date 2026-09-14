import type { Pool } from 'pg'
import { PostgresZoneRepository } from './infrastructure/postgres-zone-repository.js'

export type { Zone } from './domain/zone.js'

export function createZonesModule(pool: Pool) {
  const repository = new PostgresZoneRepository(pool)

  return { findZoneById: repository.findById.bind(repository) }
}
