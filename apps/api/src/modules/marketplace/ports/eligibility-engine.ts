import type { DriverId } from '../domain/driver-id.js'

export type EligibilityRequest = {
  orderId: string
  zoneId: string
}

export interface EligibilityEngine {
  getEligibleDrivers(input: EligibilityRequest): Promise<DriverId[]>
}
