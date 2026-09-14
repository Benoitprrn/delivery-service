import type Redis from 'ioredis'
import type { DriverAvailabilityRepository } from '../ports/driver-availability-repository.js'

const TTL_SECONDS = 300

function availabilityKey(driverId: string): string {
  return `driver:${driverId}:is_available`
}

export class ValkeyDriverAvailabilityRepository implements DriverAvailabilityRepository {
  public constructor(private readonly client: Redis) {}

  public async set(driverId: string, available: boolean): Promise<void> {
    await this.client.set(availabilityKey(driverId), available ? 'true' : 'false', 'EX', TTL_SECONDS)
  }

  public async get(driverId: string): Promise<boolean> {
    return (await this.client.get(availabilityKey(driverId))) === 'true'
  }

  public async refresh(driverId: string): Promise<boolean> {
    // EXPIRE only changes the TTL when the key still exists, atomically.
    return (await this.client.expire(availabilityKey(driverId), TTL_SECONDS)) === 1
  }
}
