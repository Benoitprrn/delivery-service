import type { DriverId } from '../domain/driver-id.js'

export interface DriverCapacityReader {
  hasCapacity(driverId: DriverId): Promise<boolean>
}
