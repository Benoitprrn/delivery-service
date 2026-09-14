import type { DriverId } from '../domain/driver-id.js'
import type { DriverCapacityReader } from '../ports/driver-capacity-reader.js'

export class AlwaysHasDriverCapacity implements DriverCapacityReader {
  async hasCapacity(_driverId: DriverId): Promise<boolean> {
    return true
  }
}
