import { NotAMondayError } from './errors.js'
import { addCalendarDays, isoWeekday, type LocalDate } from './local-date.js'
import { parisLocalDate, parisLocalTimeToUtc } from './paris-time.js'

export function previousClosingMonday(monday: LocalDate): LocalDate {
  if (isoWeekday(monday) !== 1) throw new NotAMondayError()
  return addCalendarDays(monday, -7)
}

export function latestClosableMonday(now: Date, closeAtLocal: { hour: number; minute: number } = { hour: 0, minute: 5 }): LocalDate {
  const localToday = parisLocalDate(now)
  const monday = addCalendarDays(localToday, 1 - isoWeekday(localToday))
  return parisLocalTimeToUtc(monday, closeAtLocal.hour, closeAtLocal.minute).getTime() <= now.getTime()
    ? monday
    : previousClosingMonday(monday)
}
