import { describe, expect, it } from 'vitest'
import { addBusinessDays, easterSunday, FR_CALENDAR, FR_TARGET_CALENDAR, parseLocalDate } from '../../../src/modules/settlements/public.js'

describe('business calendar', () => {
  it('computes the reference Easter dates and their dependent holidays', () => {
    expect(easterSunday(2026)).toBe('2026-04-05'); expect(easterSunday(2027)).toBe('2027-03-28')
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-04-03'))).toBe(true)
    expect(FR_TARGET_CALENDAR.isBusinessDay(parseLocalDate('2026-04-03'))).toBe(false)
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-05-14'))).toBe(false)
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-05-25'))).toBe(false)
  })
  it('knows every fixed holiday and the TARGET-only closures', () => {
    // 2025-08-15 (vendredi, Assomption) : férié FR, donc fermé aussi dans l'union
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2025-08-15'))).toBe(false)
    expect(FR_TARGET_CALENDAR.isBusinessDay(parseLocalDate('2025-08-15'))).toBe(false)
    // 2025-12-26 (vendredi) : ouvré en France, fermé TARGET/SEPA
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2025-12-26'))).toBe(true)
    expect(FR_TARGET_CALENDAR.isBusinessDay(parseLocalDate('2025-12-26'))).toBe(false)
    // samedi et dimanche jamais ouvrés ; lundi ouvré
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-09-19'))).toBe(false)
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-09-20'))).toBe(false)
    expect(FR_CALENDAR.isBusinessDay(parseLocalDate('2026-09-21'))).toBe(true)
  })
  it('computes Easter with the century correction term active (2038, 2049)', () => {
    expect(easterSunday(2038)).toBe('2038-04-25'); expect(easterSunday(2049)).toBe('2049-04-18'); expect(easterSunday(2000)).toBe('2000-04-23')
  })
  it('does not count its start day and normalizes zero on a closed day', () => {
    expect(addBusinessDays(parseLocalDate('2026-04-02'), 1, FR_TARGET_CALENDAR)).toBe('2026-04-07')
    // Lundi de Pâques est férié FR : le premier ouvré est mardi 7 avril.
    expect(addBusinessDays(parseLocalDate('2026-04-04'), 0, FR_CALENDAR)).toBe('2026-04-07')
  })
})
