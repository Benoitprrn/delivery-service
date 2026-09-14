import type { DriverLocationRepository } from '../ports/driver-location-repository.js'

export type RecordDriverLocationCommand = {
  driverId: string
  lat: number
  lng: number
  recordedAt: Date
}

const DRIVER_LOCATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export class RecordDriverLocationUseCase {
  public constructor(private readonly repository: DriverLocationRepository) {}

  public execute(command: RecordDriverLocationCommand): Promise<void> {
    // Align driver GPS retention with the seven-day proof dispute window.
    return this.repository.record({
      ...command,
      expiresAt: new Date(command.recordedAt.getTime() + DRIVER_LOCATION_RETENTION_MS)
    })
  }
}
