// Toute la logique de calcul de date de collecte vit ici, câblée sur le fuseau
// Europe/Paris explicitement (jamais le fuseau du navigateur) — cohérent avec
// la règle "UTC en base, conversion Europe/Paris côté client uniquement".
// Aucune librairie de date dans le projet : Intl.DateTimeFormat suffit.

export type PickupScheduleBody =
  | { mode: 'asap' }
  | { mode: 'delay'; delayMinutes: number }
  | { mode: 'scheduled'; at: string }

export type DelayOption = { label: string; delayMinutes: number }

// Doit rester synchronisé avec la borne max (120) du schéma Zod côté API.
export const DELAY_OPTIONS: DelayOption[] = [
  { label: '30min', delayMinutes: 30 },
  { label: '45min', delayMinutes: 45 },
  { label: '1h', delayMinutes: 60 },
  { label: '1h15', delayMinutes: 75 },
  { label: '1h30', delayMinutes: 90 },
  { label: '1h45', delayMinutes: 105 },
  { label: '2h', delayMinutes: 120 }
]

const PARIS_TZ = 'Europe/Paris'
const SLOT_STEP_MIN = 15
const SLOT_START_MIN = 11 * 60 + 15 // 11h15
const SLOT_END_MIN = 23 * 60 + 45 // 23h45 — 00h00 est ajouté à part (minuit)
const TODAY_BUFFER_MIN = 15

export type ParisYmd = { year: number; month: number; day: number }

function parisOffsetMinutes(utcGuess: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PARIS_TZ, timeZoneName: 'shortOffset' }).formatToParts(utcGuess)
  const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+1'
  const match = /GMT([+-]\d+)/.exec(tzName)
  return match !== null && match[1] !== undefined ? Number(match[1]) * 60 : 60
}

// Reconstruit l'instant UTC correspondant à une heure murale Europe/Paris
// donnée, en tenant compte du décalage horaire (CET/CEST) à cette date.
export function parisWallTimeToDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const offsetMinutes = parisOffsetMinutes(naiveUtc)
  return new Date(naiveUtc.getTime() - offsetMinutes * 60_000)
}

export function getParisYmd(date: Date): ParisYmd {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PARIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .split('-')
    .map(Number)
  return { year: parts[0] ?? 1970, month: parts[1] ?? 1, day: parts[2] ?? 1 }
}

export function getParisMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: PARIS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date)
    .split(':')
    .map(Number)
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
}

function addParisDays(ymd: ParisYmd, days: number): ParisYmd {
  // Passe par midi UTC neutre pour éviter tout glissement de date dû à un
  // décalage horaire, puis reprojette sur le calendrier Europe/Paris.
  const noon = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 12))
  return getParisYmd(new Date(noon.getTime() + days * 24 * 60 * 60_000))
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS_TZ, weekday: 'short', day: 'numeric' })

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}

export function formatDayShortFr(ymd: ParisYmd): string {
  return capitalize(WEEKDAY_FORMATTER.format(parisWallTimeToDate(ymd.year, ymd.month, ymd.day, 12, 0)))
}

export type DayOption = { ymd: ParisYmd; label: string }

export function buildDayOptions(now: Date): DayOption[] {
  const today = getParisYmd(now)
  const options: DayOption[] = []
  for (let offset = 0; offset < 7; offset += 1) {
    const ymd = offset === 0 ? today : addParisDays(today, offset)
    const label = offset === 0 ? "Aujourd'hui" : offset === 1 ? 'Demain' : formatDayShortFr(ymd)
    options.push({ ymd, label })
  }
  return options
}

export type TimeSlot = { hour: number; minute: number; isMidnight: boolean; displayLabel: string }

export function buildTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = []
  for (let minutes = SLOT_START_MIN; minutes <= SLOT_END_MIN; minutes += SLOT_STEP_MIN) {
    const hour = Math.floor(minutes / 60)
    const minute = minutes % 60
    slots.push({ hour, minute, isMidnight: false, displayLabel: `${hour}h${minute.toString().padStart(2, '0')}` })
  }
  slots.push({ hour: 0, minute: 0, isMidnight: true, displayLabel: '00h00' })
  return slots
}

// "Aujourd'hui" (dayIndex 0) filtre les créneaux déjà passés, avec un buffer
// de 15 min minimum. Les autres jours affichent tous les créneaux.
export function filterSlotsForDay(slots: TimeSlot[], dayIndex: number, now: Date): TimeSlot[] {
  if (dayIndex !== 0) {
    return slots
  }
  const cutoff = getParisMinutesOfDay(now) + TODAY_BUFFER_MIN
  return slots.filter((slot) => (slot.isMidnight ? 24 * 60 : slot.hour * 60 + slot.minute) >= cutoff)
}

export function slotToDate(ymd: ParisYmd, slot: TimeSlot): Date {
  if (slot.isMidnight) {
    const nextDay = addParisDays(ymd, 1)
    return parisWallTimeToDate(nextDay.year, nextDay.month, nextDay.day, 0, 0)
  }
  return parisWallTimeToDate(ymd.year, ymd.month, ymd.day, slot.hour, slot.minute)
}

export function formatHeureFr(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: PARIS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date)
    .split(':')
  return `${Number(parts[0] ?? 0)}h${(parts[1] ?? '00').padStart(2, '0')}`
}
