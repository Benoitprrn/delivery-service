import { InvalidLocalDateError } from './errors.js'

export type LocalDate = string & { readonly __brand: 'LocalDate' }
const DAY_MS = 86_400_000

function dayNumber(date: LocalDate): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year!, month! - 1, day!) / DAY_MS
}

export function parseLocalDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) throw new InvalidLocalDateError()
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== month || utc.getUTCDate() !== day) throw new InvalidLocalDateError()
  return value as LocalDate
}

export function formatLocalDate(date: LocalDate): string { return date }
export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) throw new InvalidLocalDateError('Day offset must be a safe integer')
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10) as LocalDate
}
export function isoWeekday(date: LocalDate): number { return ((dayNumber(date) + 3) % 7) + 1 }
export function compareLocalDates(left: LocalDate, right: LocalDate): number { return Math.sign(dayNumber(left) - dayNumber(right)) }
