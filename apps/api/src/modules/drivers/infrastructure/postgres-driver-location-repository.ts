import type { Pool } from 'pg'
import type { DriverLocation } from '../domain/driver-location.js'
import type { DriverLocationRepository } from '../ports/driver-location-repository.js'

export class PostgresDriverLocationRepository implements DriverLocationRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(location: DriverLocation): Promise<void> {
    await this.pool.query(
      `insert into driver_locations (driver_id, lat, lng, recorded_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [location.driverId, location.lat, location.lng, location.recordedAt, location.expiresAt]
    )
  }

  public async findLatestByDriverId(driverId: string): Promise<{ lat: number; lng: number } | null> {
    const result = await this.pool.query<{ lat: number; lng: number }>(
      `select lat, lng from driver_locations where driver_id = $1 order by recorded_at desc, id desc limit 1`,
      [driverId]
    )
    return result.rows[0] ?? null
  }
}
