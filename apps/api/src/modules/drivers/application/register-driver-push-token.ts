import type { DriverRepository } from '../ports/driver-repository.js'

export class RegisterDriverPushTokenUseCase {
  public constructor(private readonly driverRepository: DriverRepository) {}

  public execute(driverId: string, token: string): Promise<void> {
    return this.driverRepository.setPushToken(driverId, token)
  }
}
