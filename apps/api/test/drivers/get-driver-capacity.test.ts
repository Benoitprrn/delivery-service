import { describe, expect, it, vi } from 'vitest'
import { GetDriverCapacityUseCase } from '../../src/modules/drivers/application/get-driver-capacity.js'
import type { DriverCapacityRepository } from '../../src/modules/drivers/ports/driver-capacity-repository.js'

describe('GetDriverCapacityUseCase', () => {
  it('returns the cached capacity when the Valkey counter exists', async () => {
    const capacities: DriverCapacityRepository = {
      increment: async () => 0,
      decrement: async () => 0,
      get: async () => 1,
      set: async () => undefined
    }
    const activeOrders = { findActiveTrackingTokensByDriverId: vi.fn(async () => ['token']) }

    await expect(new GetDriverCapacityUseCase(capacities, activeOrders).execute('driver-1')).resolves.toBe(1)
    expect(activeOrders.findActiveTrackingTokensByDriverId).not.toHaveBeenCalled()
  })

  it('rebuilds and restores a missing Valkey counter from active orders', async () => {
    const set = vi.fn(async () => undefined)
    const capacities: DriverCapacityRepository = {
      increment: async () => 0,
      decrement: async () => 0,
      get: async () => null,
      set
    }

    await expect(new GetDriverCapacityUseCase(capacities, {
      findActiveTrackingTokensByDriverId: async () => ['token-1', 'token-2']
    }).execute('driver-1')).resolves.toBe(2)
    expect(set).toHaveBeenCalledWith('driver-1', 2)
  })
})
