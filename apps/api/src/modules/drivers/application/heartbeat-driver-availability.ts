import type { DriverAvailabilityRepository } from '../ports/driver-availability-repository.js'

export class HeartbeatDriverAvailabilityUseCase {
  public constructor(private readonly availabilityRepository: DriverAvailabilityRepository) {}

  public execute(driverId: string): Promise<boolean> {
    return this.availabilityRepository.refresh(driverId)
  }
}
