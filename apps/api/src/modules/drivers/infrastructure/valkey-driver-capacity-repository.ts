import type Redis from 'ioredis'
import type { DriverCapacityRepository } from '../ports/driver-capacity-repository.js'

function capacityKey(driverId: string): string {
  return `driver:${driverId}:collected_count`
}

export class ValkeyDriverCapacityRepository implements DriverCapacityRepository {
  public constructor(private readonly client: Redis) {}

  public async increment(driverId: string): Promise<number> {
    return this.client.incr(capacityKey(driverId))
  }

  public async decrement(driverId: string): Promise<number> {
    const value = await this.client.decr(capacityKey(driverId))
    if (value >= 0) return value

    // Capacity is a counter, never a debt. No TTL is deliberately applied: a
    // collected order can remain in progress for several hours.
    await this.client.set(capacityKey(driverId), '0')
    return 0
  }

  public async get(driverId: string): Promise<number | null> {
    const value = await this.client.get(capacityKey(driverId))
    return value === null ? null : Number(value)
  }

  public async set(driverId: string, capacity: number): Promise<void> {
    await this.client.set(capacityKey(driverId), String(capacity))
  }
}
