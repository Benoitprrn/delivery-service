import { describe, expect, it } from 'vitest'
import { parisWeekBounds, parseLocalDate } from '../../../src/modules/settlements/public.js'

describe('Paris time', () => {
  it.each([
    ['2026-03-23', 167, '2026-03-22T23:00:00.000Z'],
    ['2026-10-19', 169, '2026-10-18T22:00:00.000Z'],
    ['2026-09-21', 168, '2026-09-20T22:00:00.000Z'],
    ['2027-03-22', 167, '2027-03-21T23:00:00.000Z'],
    ['2027-10-25', 169, '2027-10-24T22:00:00.000Z'],
  ])('has DST-safe half-open bounds for %s', (monday, hours, start) => {
    const bounds = parisWeekBounds(parseLocalDate(monday))
    expect(bounds.startUtc.toISOString()).toBe(start)
    expect((bounds.endUtc.getTime() - bounds.startUtc.getTime()) / 3_600_000).toBe(hours)
  })
})
