import type { DriverId } from '../domain/driver-id.js'

export interface ZoneConnectionReader {
  getConnectedDriverIds(zoneId: string): Promise<readonly DriverId[]>
}
