export interface DriverAvailabilityReader {
  isAvailable(driverId: string): Promise<boolean>
}
