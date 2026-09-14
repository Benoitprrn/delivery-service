import { describe, expect, it, vi } from 'vitest'
import { GetDriverLiveProfileUseCase } from '../../src/modules/drivers/application/get-driver-live-profile.js'
import { HeartbeatDriverAvailabilityUseCase } from '../../src/modules/drivers/application/heartbeat-driver-availability.js'
import { SetDriverAvailabilityUseCase } from '../../src/modules/drivers/application/set-driver-availability.js'
import type { DriverAvailabilityRepository } from '../../src/modules/drivers/ports/driver-availability-repository.js'

class MemoryAvailabilityRepository implements DriverAvailabilityRepository {
  private readonly values = new Map<string, boolean>()
  async set(id: string, available: boolean): Promise<void> { this.values.set(id, available) }
  async get(id: string): Promise<boolean> { return this.values.get(id) === true }
  async refresh(id: string): Promise<boolean> { return this.values.has(id) }
  expire(id: string): void { this.values.delete(id) }
}

describe('driver availability use cases', () => {
  it('sets availability and synchronizes in-process socket presence', async () => {
    const repository = new MemoryAvailabilityRepository()
    const sync = vi.fn()
    await expect(new SetDriverAvailabilityUseCase(repository, sync).execute('driver-1', true)).resolves.toEqual({ available: true })
    await expect(repository.get('driver-1')).resolves.toBe(true)
    expect(sync).toHaveBeenCalledWith('driver-1', true)
  })

  it('does not recreate expired availability on heartbeat', async () => {
    const repository = new MemoryAvailabilityRepository()
    await repository.set('driver-1', true)
    expect(await new HeartbeatDriverAvailabilityUseCase(repository).execute('driver-1')).toBe(true)
    repository.expire('driver-1')
    expect(await new HeartbeatDriverAvailabilityUseCase(repository).execute('driver-1')).toBe(false)
    expect(await repository.get('driver-1')).toBe(false)
  })

  it('overrides the legacy Postgres availability with the live value', async () => {
    const repository = new MemoryAvailabilityRepository()
    const useCase = new GetDriverLiveProfileUseCase({ findById: async () => ({ id: 'driver-1', name: 'A', phone: null, zoneId: 'zone-1', isAvailable: true }) }, repository)
    await expect(useCase.execute('driver-1')).resolves.toMatchObject({ isAvailable: false })
  })
})
