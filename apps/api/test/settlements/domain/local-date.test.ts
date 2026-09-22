import { describe, expect, it } from 'vitest'
import { addCalendarDays, compareLocalDates, isoWeekday, parseLocalDate } from '../../../src/modules/settlements/public.js'

describe('local dates', () => {
  it('uses calendar arithmetic across a DST boundary', () => expect(addCalendarDays(parseLocalDate('2026-03-29'), 1)).toBe('2026-03-30'))
  it('uses ISO weekdays', () => expect(isoWeekday(parseLocalDate('2026-09-21'))).toBe(1))
  it.each(['2026-02-29', '2026-13-01', '2026-1-01'])('rejects invalid dates', (date) => expect(() => parseLocalDate(date)).toThrow())
  it('compares exact day numbers', () => expect(compareLocalDates(parseLocalDate('2026-01-01'), parseLocalDate('2026-01-02'))).toBe(-1))
})
