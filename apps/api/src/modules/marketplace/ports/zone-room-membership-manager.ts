import type { DriverId } from '../domain/driver-id.js'

export interface ZoneRoomMembershipManager {
  removeDriverFromZone(driverId: DriverId, zoneId: string): Promise<void>
}
