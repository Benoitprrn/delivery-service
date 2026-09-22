import { FR_TARGET_CALENDAR, nextBusinessDayOnOrAfter } from './business-calendar.js'
import { addCalendarDays, compareLocalDates, isoWeekday, type LocalDate } from './local-date.js'
import { parisLocalDate } from './paris-time.js'

/** Préavis SEPA minimal : le prélèvement ne peut pas partir moins de 2 jours calendaires (Europe/Paris) après l'envoi. */
export const PRE_NOTIFICATION_NOTICE_DAYS = 2

/**
 * Date de prélèvement ANNONCÉE dans l'e-mail : le mercredi prévu par le calendrier, repoussée au premier jour ouvré
 * (FR ∪ TARGET) laissant 2 jours calendaires pleins après l'envoi (envoi tardif après un retry ou une panne).
 */
export function announcedDebitDate(input: { scheduledDebitDate: LocalDate; sentAt: Date }): LocalDate {
  const earliest = addCalendarDays(parisLocalDate(input.sentAt), PRE_NOTIFICATION_NOTICE_DAYS)
  const floor = compareLocalDates(input.scheduledDebitDate, earliest) >= 0 ? input.scheduledDebitDate : earliest
  return nextBusinessDayOnOrAfter(floor, FR_TARGET_CALENDAR)
}

/** Délai avant la prochaine tentative après un échec d'envoi : 1 min, 2, 4… plafonné à 1 h. */
export function preNotificationRetryDelaySeconds(attemptCount: number): number {
  return Math.min(3600, 60 * 2 ** Math.max(0, Math.min(attemptCount, 10) - 1))
}

const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'] as const

/** « 1 384,00 € » — arithmétique entière uniquement (jamais de float pour l'argent). */
export function formatEuroCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('cents must be a non-negative safe integer')
  const euros = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')
  return `${euros},${(cents % 100).toString().padStart(2, '0')}\u00a0€`
}

export function formatFrenchDate(date: LocalDate, withWeekday = true): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const base = `${day === 1 ? '1er' : day} ${MONTHS[month - 1]} ${year}`
  return withWeekday ? `${WEEKDAYS[isoWeekday(date) - 1]} ${base}` : base
}

export type PreNotificationEmailInput = {
  legalName: string
  amountCents: number
  debitDate: LocalDate
  periodFirstDay: LocalDate
  periodLastDay: LocalDate
  ibanLast4: string
  mandateReference: string
  creditorId: string
  supportEmail: string
}

export type PreNotificationEmail = { subject: string; text: string; html: string }

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * Contenu de la pré-notification SEPA : montant exact, date, 4 derniers caractères de l'IBAN (jamais l'IBAN entier), référence
 * unique du mandat, identifiant créancier SEPA (celui de Stripe, présenté comme tel), contact. Aucune autre donnée bancaire.
 */
export function buildPreNotificationEmail(input: PreNotificationEmailInput): PreNotificationEmail {
  const amount = formatEuroCents(input.amountCents)
  const debit = formatFrenchDate(input.debitDate)
  const period = `du ${formatFrenchDate(input.periodFirstDay)} au ${formatFrenchDate(input.periodLastDay)}`
  const rows: Array<[string, string]> = [
    ['Montant prélevé', amount],
    ['Date de prélèvement', debit],
    ['Compte débité', `IBAN se terminant par ${input.ibanLast4}`],
    ['Référence unique du mandat SEPA', input.mandateReference],
    ['Identifiant créancier SEPA (attribué par notre prestataire de paiement Stripe)', input.creditorId],
    ['Facturé par', 'Locadely'],
    ['Période concernée', period]
  ]
  const subject = `Prélèvement SEPA de ${amount} le ${debit}`
  const intro = `Locadely prélèvera ${amount} sur votre compte bancaire (IBAN se terminant par ${input.ibanLast4}) le ${debit}.`
  const outro = `Aucune action n'est nécessaire. Pour toute question sur ce prélèvement, écrivez-nous à ${input.supportEmail}.`
  const text = [`Bonjour ${input.legalName},`, '', intro, '', ...rows.map(([label, value]) => `- ${label} : ${value}`), '', outro, '', 'Locadely'].join('\n')
  const html = `<p>Bonjour ${escapeHtml(input.legalName)},</p><p>${escapeHtml(intro)}</p><ul>${rows.map(([label, value]) => `<li>${escapeHtml(label)} : <strong>${escapeHtml(value)}</strong></li>`).join('')}</ul><p>${escapeHtml(outro)}</p><p>Locadely</p>`
  return { subject, text, html }
}
