import { LocalEligibilityEngine } from './application/local-eligibility-engine.js'
import { AlwaysHasDriverCapacity } from './infrastructure/always-has-driver-capacity.js'
import type { DriverAvailabilityReader } from './ports/driver-availability-reader.js'
import type { EligibilityEngine } from './ports/eligibility-engine.js'
import type { ZoneConnectionReader } from './ports/zone-connection-reader.js'
import type { ZoneRoomMembershipManager } from './ports/zone-room-membership-manager.js'

export type { DriverId } from './domain/driver-id.js'
export type { EligibilityEngine, EligibilityRequest } from './ports/eligibility-engine.js'

export type MarketplaceDependencies = {
  zoneConnections: ZoneConnectionReader
  availability: DriverAvailabilityReader
  zoneMembership: ZoneRoomMembershipManager
}

export function createMarketplaceModule(dependencies: MarketplaceDependencies): { eligibilityEngine: EligibilityEngine } {
  return {
    eligibilityEngine: new LocalEligibilityEngine(
      dependencies.zoneConnections,
      dependencies.availability,
      new AlwaysHasDriverCapacity(),
      dependencies.zoneMembership
    )
  }
}
