import type { DriverId } from '../domain/driver-id.js'

export interface DriverAvailabilityReader {
  isAvailable(driverId: DriverId): Promise<boolean>
}
