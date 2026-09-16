import type { Driver } from '../domain/driver.js'

export interface DriverRepository {
  findById(id: string): Promise<Driver | null>
  findIdsByZoneId(zoneId: string): Promise<string[]>
  setPushToken(driverId: string, token: string): Promise<void>
  findPushTokensByDriverIds(driverIds: readonly string[]): Promise<string[]>
}
