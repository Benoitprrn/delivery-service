import type { DriverLocation } from '../domain/driver-location.js'

export interface DriverLocationRepository {
  // expiresAt is application-owned so retention stays deterministic across inserts.
  record(location: DriverLocation): Promise<void>
  findLatestByDriverId(driverId: string): Promise<{ lat: number; lng: number } | null>
}
