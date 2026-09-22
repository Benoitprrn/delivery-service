import { addCalendarDays, isoWeekday, parseLocalDate, type LocalDate } from './local-date.js'
import { InvalidBusinessDaysError } from './errors.js'

export type BusinessCalendar = { isBusinessDay(date: LocalDate): boolean }
export function easterSunday(year: number): LocalDate {
  if (!Number.isInteger(year) || year < 1583) throw new InvalidBusinessDaysError()
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100; const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1
  return parseLocalDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
}
function fixed(year: number, month: number, day: number): LocalDate { return parseLocalDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) }
export function frenchPublicHolidays(year: number): readonly LocalDate[] {
  const easter = easterSunday(year)
  return [fixed(year, 1, 1), addCalendarDays(easter, 1), fixed(year, 5, 1), fixed(year, 5, 8), addCalendarDays(easter, 39), addCalendarDays(easter, 50), fixed(year, 7, 14), fixed(year, 8, 15), fixed(year, 11, 1), fixed(year, 11, 11), fixed(year, 12, 25)]
}
export function targetClosedDays(year: number): readonly LocalDate[] { const easter = easterSunday(year); return [fixed(year, 1, 1), addCalendarDays(easter, -2), addCalendarDays(easter, 1), fixed(year, 5, 1), fixed(year, 12, 25), fixed(year, 12, 26)] }
function holidaysFor(date: LocalDate, target: boolean): Set<string> { const year = Number(date.slice(0, 4)); return new Set([...frenchPublicHolidays(year), ...(target ? targetClosedDays(year) : [])]) }
function createCalendar(target: boolean): BusinessCalendar { return { isBusinessDay: (date) => isoWeekday(date) <= 5 && !holidaysFor(date, target).has(date) } }
export const FR_CALENDAR = createCalendar(false)
export const FR_TARGET_CALENDAR = createCalendar(true)
export function nextBusinessDayOnOrAfter(from: LocalDate, calendar: BusinessCalendar): LocalDate { let date = from; while (!calendar.isBusinessDay(date)) date = addCalendarDays(date, 1); return date }
export function addBusinessDays(from: LocalDate, count: number, calendar: BusinessCalendar): LocalDate {
  if (!Number.isSafeInteger(count) || count < 0) throw new InvalidBusinessDaysError()
  let date = nextBusinessDayOnOrAfter(from, calendar)
  for (let added = 0; added < count; added += 1) date = nextBusinessDayOnOrAfter(addCalendarDays(date, 1), calendar)
  return date
}
