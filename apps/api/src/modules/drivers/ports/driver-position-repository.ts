export interface DriverPositionRepository {
  record(driverId: string, position: { lat: number; lng: number }, recordedAt: Date): Promise<void>
  clear(driverId: string): Promise<void>
  findAllWithinRadius(
    center: { lat: number; lng: number },
    radiusKm: number,
    excludeDriverIds: readonly string[]
  ): Promise<{ driverId: string; lat: number; lng: number }[]>
}
