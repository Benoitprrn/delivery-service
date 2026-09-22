import type { Pool } from 'pg'
import type { Zone } from '../domain/zone.js'
import type { FindContainingPointResult, ZoneRepository } from '../ports/zone-repository.js'
import type { LatLng } from '../../geocoding/public.js'

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

  public async findContainingPoint(point: LatLng): Promise<FindContainingPointResult> {
    const result = await this.pool.query<ZoneRow>(
      `select id, name, center_lat, center_lng, radius_km from zones
       where 6371000 * acos(least(1, greatest(-1,
         cos(radians($1)) * cos(radians(center_lat)) * cos(radians(center_lng) - radians($2)) +
         sin(radians($1)) * sin(radians(center_lat))
       ))) <= radius_km * 1000`, [point.lat, point.lng]
    )
    const zones = result.rows.map((row) => ({ id: row.id, name: row.name, centerLat: row.center_lat, centerLng: row.center_lng, radiusKm: row.radius_km }))
    if (zones.length === 0) return { kind: 'none' }
    if (zones.length === 1) return { kind: 'one', zone: zones[0]! }
    return { kind: 'multiple', zones }
  }
}
