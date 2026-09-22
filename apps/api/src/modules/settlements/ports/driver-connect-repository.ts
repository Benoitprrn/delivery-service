import type { DriverEntityType } from '../domain/driver-account.js'
import type { CapabilityState, RequirementsState } from './driver-connect-provider.js'

export type DriverConnectAccountRecord = {
  driverId: string
  stripeAccountId: string
  entityType: DriverEntityType
  transfersStatus: string
  payoutsStatus: string
  requirementsState: string
  restrictedAt: Date | null
  lastSyncedAt: Date | null
}

export interface DriverConnectRepository {
  findByDriverId(driverId: string): Promise<DriverConnectAccountRecord | null>
  /** Un livreur = un compte : un doublon (même livreur) est ignoré, l'appelant relit ensuite la ligne. */
  insertIfAbsent(input: { driverId: string; stripeAccountId: string; entityType: DriverEntityType; livemode: boolean }): Promise<void>
  updateStatus(driverId: string, status: { transfers: CapabilityState; payouts: CapabilityState; requirements: RequirementsState }): Promise<DriverConnectAccountRecord | null>
  findDriverIdByAccountId(accountId: string): Promise<string | null>
}
