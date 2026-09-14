import type { Pool } from 'pg'
import type { Zone } from '../domain/zone.js'
import type { ZoneRepository } from '../ports/zone-repository.js'

type ZoneRow = {
  id: string
  name: string
  center_lat: number
  center_lng: number
  radius_km: number
}

export class PostgresZoneRepository implements ZoneRepository {
  public constructor(private readonly pool: Pool) {}

  public async findById(id: string): Promise<Zone | null> {
    const result = await this.pool.query<ZoneRow>(
      'select id, name, center_lat, center_lng, radius_km from zones where id = $1',
      [id]
    )
    const row = result.rows[0]

    return row === undefined
      ? null
      : {
          id: row.id,
          name: row.name,
          centerLat: row.center_lat,
          centerLng: row.center_lng,
          radiusKm: row.radius_km
        }
  }
}
