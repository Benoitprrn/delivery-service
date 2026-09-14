import type { DriverId } from '../domain/driver-id.js'
import type { DriverAvailabilityReader } from '../ports/driver-availability-reader.js'
import type { DriverCapacityReader } from '../ports/driver-capacity-reader.js'
import type { EligibilityEngine, EligibilityRequest } from '../ports/eligibility-engine.js'
import type { ZoneConnectionReader } from '../ports/zone-connection-reader.js'
import type { ZoneRoomMembershipManager } from '../ports/zone-room-membership-manager.js'

export class LocalEligibilityEngine implements EligibilityEngine {
  constructor(
    private readonly zoneConnections: ZoneConnectionReader,
    private readonly availability: DriverAvailabilityReader,
    private readonly capacity: DriverCapacityReader,
    private readonly zoneMembership: ZoneRoomMembershipManager
  ) {}

  async getEligibleDrivers({ zoneId }: EligibilityRequest): Promise<DriverId[]> {
    const connectedDriverIds = await this.zoneConnections.getConnectedDriverIds(zoneId)
    const uniqueDriverIds = [...new Set(connectedDriverIds)]
    const availableDriverIds: DriverId[] = []
    const eligibleDriverIds: DriverId[] = []

    for (const driverId of uniqueDriverIds) {
      if (!await this.availability.isAvailable(driverId)) {
        await this.zoneMembership.removeDriverFromZone(driverId, zoneId)
        continue
      }
      availableDriverIds.push(driverId)
    }

    for (const driverId of availableDriverIds) {
      if (await this.capacity.hasCapacity(driverId)) eligibleDriverIds.push(driverId)
    }

    return eligibleDriverIds
  }
}
