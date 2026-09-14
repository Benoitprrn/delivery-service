import type { DriverAvailabilityRepository } from '../ports/driver-availability-repository.js'

export class SetDriverAvailabilityUseCase {
  public constructor(
    private readonly availabilityRepository: DriverAvailabilityRepository,
    private readonly syncPresence: (driverId: string, available: boolean) => Promise<void> | void
  ) {}

  public async execute(driverId: string, available: boolean): Promise<{ available: boolean }> {
    await this.availabilityRepository.set(driverId, available)
    await this.syncPresence(driverId, available)
    return { available }
  }
}
