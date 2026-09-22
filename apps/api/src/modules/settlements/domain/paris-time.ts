import { addCalendarDays, parseLocalDate, type LocalDate } from './local-date.js'
import { InvalidLocalDateError } from './errors.js'

const parisFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function parisParts(instant: Date): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(parisFormatter.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return { date: `${parts.year!}-${parts.month!}-${parts.day!}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}
export function parisLocalDate(instant: Date): LocalDate { return parseLocalDate(parisParts(instant).date) }
export function parisLocalTimeToUtc(date: LocalDate, hour: number, minute: number): Date {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new InvalidLocalDateError('Paris time is invalid')
  const [year, month, day] = date.split('-').map(Number)
  const nominal = Date.UTC(year!, month! - 1, day!, hour, minute)
  for (let delta = -180; delta <= 180; delta += 1) {
    const candidate = new Date(nominal + delta * 60_000)
    const local = parisParts(candidate)
    if (local.date === date && local.hour === hour && local.minute === minute) return candidate
  }
  throw new InvalidLocalDateError('Paris local time does not exist')
}
export function parisMidnightToUtc(date: LocalDate): Date { return parisLocalTimeToUtc(date, 0, 0) }
export function parisWeekBounds(mondayLocalDate: LocalDate): { startUtc: Date; endUtc: Date } {
  parseLocalDate(mondayLocalDate)
  return { startUtc: parisMidnightToUtc(mondayLocalDate), endUtc: parisMidnightToUtc(addCalendarDays(mondayLocalDate, 7)) }
}
