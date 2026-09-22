import { addBusinessDays, FR_CALENDAR, FR_TARGET_CALENDAR, nextBusinessDayOnOrAfter, type BusinessCalendar } from './business-calendar.js'
import { NotAMondayError } from './errors.js'
import { addCalendarDays, compareLocalDates, isoWeekday, type LocalDate } from './local-date.js'
import { parisLocalTimeToUtc, parisWeekBounds } from './paris-time.js'

export function computeSettlementSchedule(input: { closingMonday: LocalDate; payrunDelayBusinessDays?: number; promiseBusinessDays?: number; payrunLocalHour?: number; payrunCalendar?: BusinessCalendar; promiseCalendar?: BusinessCalendar }): { periodStart: Date; periodEnd: Date; debitDate: LocalDate; payrunDate: LocalDate; payrunAtUtc: Date; promiseDeadline: LocalDate; payrunClampedToDeadline: boolean } {
  const { closingMonday, payrunDelayBusinessDays = 7, promiseBusinessDays = 15, payrunLocalHour = 10, payrunCalendar = FR_TARGET_CALENDAR, promiseCalendar = FR_CALENDAR } = input
  if (isoWeekday(closingMonday) !== 1) throw new NotAMondayError()
  const period = parisWeekBounds(addCalendarDays(closingMonday, -7))
  const debitDate = nextBusinessDayOnOrAfter(addCalendarDays(closingMonday, 2), payrunCalendar)
  const candidatePayrunDate = addBusinessDays(debitDate, payrunDelayBusinessDays, payrunCalendar)
  const promiseDeadline = addBusinessDays(closingMonday, promiseBusinessDays, promiseCalendar)
  const payrunClampedToDeadline = compareLocalDates(candidatePayrunDate, promiseDeadline) > 0
  const payrunDate = payrunClampedToDeadline ? promiseDeadline : candidatePayrunDate
  return { periodStart: period.startUtc, periodEnd: period.endUtc, debitDate, payrunDate, payrunAtUtc: parisLocalTimeToUtc(payrunDate, payrunLocalHour, 0), promiseDeadline, payrunClampedToDeadline }
}
