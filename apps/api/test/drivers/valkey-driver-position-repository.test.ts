import { describe, expect, it, vi } from 'vitest'
import type Redis from 'ioredis'
import { ValkeyDriverPositionRepository } from '../../src/modules/drivers/infrastructure/valkey-driver-position-repository.js'

describe('ValkeyDriverPositionRepository', () => {
  it('records both position views atomically and uses the position-id index for radius searches', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1)
    const client = {
      eval: evalCommand,
      del: vi.fn().mockResolvedValue(2),
      srem: vi.fn().mockResolvedValue(1),
      smembers: vi.fn().mockResolvedValue(['nearby', 'excluded', 'far-away']),
      mget: vi.fn().mockResolvedValue([
        JSON.stringify({ lat: 46.2058, lng: 5.2255, recordedAt: '2026-09-14T10:00:00.000Z' }), null,
        null, JSON.stringify({ lat: 46.2059, lng: 5.2255, recordedAt: '2026-09-14T10:00:00.000Z' }),
        JSON.stringify({ lat: 46.3, lng: 5.2255, recordedAt: '2026-09-14T10:00:00.000Z' }), null
      ])
    } as unknown as Redis
    const repository = new ValkeyDriverPositionRepository(client)

    await repository.record('nearby', { lat: 46.2058, lng: 5.2255 }, new Date('2026-09-14T10:00:00.000Z'))

    expect(evalCommand).toHaveBeenCalledWith(
      expect.any(String), 3,
      'driver:{nearby}:current_position', 'driver:{nearby}:last_known_position', 'drivers:position_ids',
      expect.stringContaining('"recordedAt":"2026-09-14T10:00:00.000Z"'), '2026-09-14T10:00:00.000Z', '300', 'nearby'
    )
    await expect(repository.findAllWithinRadius({ lat: 46.2058, lng: 5.2255 }, 1, ['excluded']))
      .resolves.toEqual([{ driverId: 'nearby', lat: 46.2058, lng: 5.2255 }])
  })

  it('removes both position keys and the driver from the index', async () => {
    const evalCommand = vi.fn().mockResolvedValue(1)
    const client = { eval: evalCommand } as unknown as Redis
    const repository = new ValkeyDriverPositionRepository(client)

    await repository.clear('driver-1')

    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1], KEYS[2])"), 3,
      'driver:{driver-1}:current_position', 'driver:{driver-1}:last_known_position', 'drivers:position_ids', 'driver-1'
    )
  })
})
