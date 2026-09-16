import { describe, expect, it, vi } from 'vitest'
import { DisconnectDriverUseCase } from '../../src/modules/drivers/application/disconnect-driver.js'

describe('DisconnectDriverUseCase', () => {
  it('marks the driver unavailable, clears both position views through the repository, and removes socket presence', async () => {
    const availability = { set: vi.fn().mockResolvedValue(undefined) }
    const positions = { clear: vi.fn().mockResolvedValue(undefined) }
    const syncPresence = vi.fn()
    const useCase = new DisconnectDriverUseCase(availability as never, positions as never, syncPresence)

    await useCase.execute('driver-1')

    expect(availability.set).toHaveBeenCalledWith('driver-1', false)
    expect(positions.clear).toHaveBeenCalledWith('driver-1')
    expect(syncPresence).toHaveBeenCalledWith('driver-1', false)
  })
})
