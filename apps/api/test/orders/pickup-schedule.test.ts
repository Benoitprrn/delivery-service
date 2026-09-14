import { describe, expect, it } from 'vitest'
import { PastPickupScheduleError, resolvePickupScheduledAt } from '../../src/modules/orders/domain/pickup-schedule.js'

describe('resolvePickupScheduledAt', () => {
  const now = new Date('2026-09-13T10:00:00.000Z')

  it('resolves asap, delayed, and explicitly scheduled pickups', () => {
    expect(resolvePickupScheduledAt({ mode: 'asap' }, now)).toBe(now)
    expect(resolvePickupScheduledAt({ mode: 'delay', delayMinutes: 45 }, now).toISOString()).toBe('2026-09-13T10:45:00.000Z')
    expect(resolvePickupScheduledAt({ mode: 'scheduled', at: new Date('2026-09-13T13:00:00+02:00') }, now).toISOString()).toBe('2026-09-13T11:00:00.000Z')
  })

  it('rejects every schedule whose resolved time is in the past', () => {
    expect(() => resolvePickupScheduledAt({ mode: 'asap' }, new Date('2026-09-13T09:59:59.999Z'))).not.toThrow()
    expect(() => resolvePickupScheduledAt({ mode: 'delay', delayMinutes: -1 }, now)).toThrow(PastPickupScheduleError)
    expect(() => resolvePickupScheduledAt({ mode: 'scheduled', at: new Date('2026-09-13T09:59:59.999Z') }, now)).toThrow(PastPickupScheduleError)
  })
})
