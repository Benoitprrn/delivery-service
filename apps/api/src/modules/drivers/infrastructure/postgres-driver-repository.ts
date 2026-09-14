import type { Pool } from 'pg'
import type { Driver } from '../domain/driver.js'
import type { DriverRepository } from '../ports/driver-repository.js'

type DriverRow = {
  id: string
  name: string
  phone: string | null
  zone_id: string
  is_available: boolean
}

export class PostgresDriverRepository implements DriverRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string): Promise<Driver | null> {
    const result = await this.pool.query<DriverRow>(
      'select id, name, phone, zone_id, is_available from drivers where id = $1',
      [id]
    )
    const row = result.rows[0]

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          phone: row.phone,
          zoneId: row.zone_id,
          // Postgres retains this legacy field, but Valkey is the live availability source of truth.
          isAvailable: row.is_available
        }
  }
}
