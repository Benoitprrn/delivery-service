import { describe, expect, it } from 'vitest'
import { announcedDebitDate, buildPreNotificationEmail, formatEuroCents, formatFrenchDate, parseLocalDate, preNotificationRetryDelaySeconds } from '../../../src/modules/settlements/public.js'

const day = parseLocalDate

describe('announcedDebitDate', () => {
  it.each([
    ['Monday 00:05 Paris (Sunday 22:05Z) keeps Wednesday', '2026-08-30T22:05:00Z', '2026-09-02', '2026-09-02'],
    ['Monday late evening keeps Wednesday', '2026-08-31T21:00:00Z', '2026-09-02', '2026-09-02'],
    ['Tuesday morning (late retry) moves to Thursday: 2 full calendar days', '2026-09-01T08:00:00Z', '2026-09-02', '2026-09-03'],
    ['Wednesday send moves to Friday', '2026-09-02T08:00:00Z', '2026-09-02', '2026-09-04'],
    ['Thursday send lands on Saturday and moves to Monday', '2026-09-03T08:00:00Z', '2026-09-02', '2026-09-07'],
    ['scheduled date already later is never brought forward', '2026-08-30T22:05:00Z', '2026-09-04', '2026-09-04'],
    ['public holiday target day is skipped (Monday 2026-05-25 Whit Monday)', '2026-05-22T08:00:00Z', '2026-05-24', '2026-05-26'],
  ])('%s', (_label, sentAt, scheduled, expected) => {
    expect(announcedDebitDate({ scheduledDebitDate: day(scheduled), sentAt: new Date(sentAt) })).toBe(expected)
  })
})

describe('preNotificationRetryDelaySeconds', () => {
  it('backs off 1, 2, 4… minutes and caps at one hour', () => {
    expect([1, 2, 3, 4, 7, 8, 30].map(preNotificationRetryDelaySeconds)).toEqual([60, 120, 240, 480, 3600, 3600, 3600])
  })
})

describe('formatting', () => {
  it.each([[0, '0,00 €'], [5, '0,05 €'], [138_400, '1 384,00 €'], [100_000_001, '1 000 000,01 €']])('formats %i cents with integer arithmetic', (cents, expected) => expect(formatEuroCents(cents)).toBe(expected))
  it('refuses floats and negatives', () => { expect(() => formatEuroCents(1.5)).toThrow(); expect(() => formatEuroCents(-1)).toThrow() })
  it('writes French dates with weekday', () => {
    expect(formatFrenchDate(day('2026-09-02'))).toBe('mercredi 2 septembre 2026')
    expect(formatFrenchDate(day('2026-09-01'))).toBe('mardi 1er septembre 2026')
  })
})

describe('buildPreNotificationEmail', () => {
  const input = { legalName: 'Chez <Marcel> & Fils', amountCents: 138_400, debitDate: day('2026-09-02'), periodFirstDay: day('2026-08-24'), periodLastDay: day('2026-08-30'), ibanLast4: '4242', mandateReference: 'MANDATE-REF-1', creditorId: 'STRIPE-CREDITOR-ID', supportEmail: 'support@example.test' }
  const email = buildPreNotificationEmail(input)

  it('announces the exact amount, the debit date, the last 4 IBAN characters, the mandate reference, the creditor id and the contact', () => {
    for (const part of ['1 384,00 €', 'mercredi 2 septembre 2026', 'IBAN se terminant par 4242', 'MANDATE-REF-1', 'STRIPE-CREDITOR-ID', 'support@example.test', 'lundi 24 août 2026', 'dimanche 30 août 2026']) {
      expect(email.text).toContain(part)
      expect(email.html).toContain(part.replace(/&/g, '&amp;'))
    }
    expect(email.subject).toBe('Prélèvement SEPA de 1 384,00 € le mercredi 2 septembre 2026')
  })
  it('presents the creditor id as the payment provider identifier, never as a Locadely one, and exposes no full IBAN', () => {
    expect(email.text).toContain('attribué par notre prestataire de paiement Stripe')
    expect(email.text).not.toMatch(/[A-Z]{2}\d{2}[A-Z0-9]{10,}/)
  })
  it('escapes the merchant name in HTML', () => {
    expect(email.html).toContain('Chez &lt;Marcel&gt; &amp; Fils')
    expect(email.html).not.toContain('<Marcel>')
  })
})
