import { describe, expect, it } from 'vitest'
import { latestClosableMonday, parseLocalDate, previousClosingMonday } from '../../../src/modules/settlements/public.js'

describe('closing schedule', () => {
  it.each([
    ['Monday before closing', '2026-09-20T22:04:59.999Z', '2026-09-14'],
    ['Monday at closing', '2026-09-20T22:05:00.000Z', '2026-09-21'],
    ['Sunday late', '2026-09-20T21:59:00.000Z', '2026-09-14'],
    ['Tuesday', '2026-09-22T10:00:00.000Z', '2026-09-21'],
    ['Saturday', '2026-09-26T10:00:00.000Z', '2026-09-21'],
    ['summer DST -1 ms', '2026-03-29T22:04:59.999Z', '2026-03-23'],
    ['summer DST at', '2026-03-29T22:05:00.000Z', '2026-03-30'],
    ['winter DST -1 ms', '2026-10-25T23:04:59.999Z', '2026-10-19'],
    ['winter DST at', '2026-10-25T23:05:00.000Z', '2026-10-26'],
    ['new year', '2027-01-03T23:05:00.000Z', '2027-01-04'],
  ])('%s resolves the latest eligible Monday', (_label, instant, expected) => expect(latestClosableMonday(new Date(instant))).toBe(expected))

  it('uses a custom local close time', () => expect(latestClosableMonday(new Date('2026-09-20T22:04:00.000Z'), { hour: 0, minute: 4 })).toBe('2026-09-21'))
  it('returns the preceding Monday', () => expect(previousClosingMonday(parseLocalDate('2027-01-04'))).toBe('2026-12-28'))
})
