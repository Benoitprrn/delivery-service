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
}
