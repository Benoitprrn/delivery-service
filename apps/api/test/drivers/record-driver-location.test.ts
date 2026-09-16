import { describe, expect, it, vi } from 'vitest'
import { RecordDriverLocationUseCase } from '../../src/modules/drivers/application/record-driver-location.js'

describe('RecordDriverLocationUseCase tracking fanout', () => {
  it('persists before emitting the minimal public payload for active tracking tokens', async () => {
    const sequence: string[] = []
    const emitTrackingPosition = vi.fn(() => { sequence.push('emit') })
    const useCase = new RecordDriverLocationUseCase(
      { record: async () => { sequence.push('record') } },
      { record: async () => { sequence.push('position') }, clear: async () => undefined, findAllWithinRadius: async () => [] },
      { findActiveTrackingTokensByDriverId: async () => ['11111111-1111-4111-8111-111111111111'] },
      { emitTrackingPosition }
    )
    await useCase.execute({ driverId: 'driver-id', lat: 46.2, lng: 5.2, recordedAt: new Date('2026-09-14T10:00:00Z') })
    expect(sequence).toEqual(['position', 'record', 'emit'])
    expect(emitTrackingPosition).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { lat: 46.2, lng: 5.2 })
  })

  it('does not emit without active orders and ignores fanout errors', async () => {
    const emitTrackingPosition = vi.fn()
    const useCase = new RecordDriverLocationUseCase(
      { record: async () => { throw new Error('history must not be written') } },
      { record: async () => undefined, clear: async () => undefined, findAllWithinRadius: async () => [] },
      { findActiveTrackingTokensByDriverId: async () => { throw new Error('socket dependency unavailable') } },
      { emitTrackingPosition }
    )
    await expect(useCase.execute({ driverId: 'driver-id', lat: 46.2, lng: 5.2, recordedAt: new Date() })).resolves.toBeUndefined()
    expect(emitTrackingPosition).not.toHaveBeenCalled()
  })

})
