import type { DriverAvailabilityRepository } from '../ports/driver-availability-repository.js'
import type { DriverPositionRepository } from '../ports/driver-position-repository.js'

/** Clears the ephemeral state owned by a driver's authenticated connection. */
export class DisconnectDriverUseCase {
  public constructor(
    private readonly availabilityRepository: DriverAvailabilityRepository,
    private readonly positions: DriverPositionRepository,
    private readonly syncPresence: (driverId: string, available: boolean) => Promise<void> | void
  ) {}

  public async execute(driverId: string): Promise<void> {
    await this.availabilityRepository.set(driverId, false)
    await this.positions.clear(driverId)
    await this.syncPresence(driverId, false)
  }
}
