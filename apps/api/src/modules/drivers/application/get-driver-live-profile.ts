import type { Driver } from '../domain/driver.js'
import type { DriverAvailabilityRepository } from '../ports/driver-availability-repository.js'
import type { DriverRepository } from '../ports/driver-repository.js'

export class GetDriverLiveProfileUseCase {
  public constructor(
    private readonly driverRepository: DriverRepository,
    private readonly availabilityRepository: DriverAvailabilityRepository
  ) {}

  public async execute(driverId: string): Promise<Driver | null> {
    const driver = await this.driverRepository.findById(driverId)
    if (driver === null) return null
    return { ...driver, isAvailable: await this.availabilityRepository.get(driverId) }
  }
}
