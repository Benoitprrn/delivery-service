export interface DriverAvailabilityRepository {
  set(driverId: string, available: boolean): Promise<void>
  get(driverId: string): Promise<boolean>
  /** Refreshes an existing key only; false means it had already expired. */
  refresh(driverId: string): Promise<boolean>
}
