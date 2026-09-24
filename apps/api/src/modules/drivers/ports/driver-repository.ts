import type { Driver } from '../domain/driver.js'
import type { DriverLegalInformation } from '../application/legal-information.js'

export interface DriverRepository {
  findById(id: string): Promise<Driver | null>
  findIdsByZoneId(zoneId: string): Promise<string[]>
  setPushToken(driverId: string, token: string): Promise<void>
  updateProfile?(driverId: string, profile: { firstName: string; lastName: string; phone: string }): Promise<Driver | null>
  findPushTokensByDriverIds(driverIds: readonly string[]): Promise<string[]>
}
export interface DriverLegalInformationRepository { findLegalInformation(driverId: string): Promise<DriverLegalInformation | null>; upsertLegalInformation(value: DriverLegalInformation): Promise<DriverLegalInformation> }
