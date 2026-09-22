import { describe, expect, it } from 'vitest'
import { computeSettlementSchedule, parseLocalDate } from '../../../src/modules/settlements/public.js'

describe('settlement schedule', () => {
  it('matches the ADR reference date', () => {
    const schedule = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-09-21') })
    expect(schedule.debitDate).toBe('2026-09-23'); expect(schedule.payrunDate).toBe('2026-10-02'); expect(schedule.promiseDeadline).toBe('2026-10-12')
  })
  it('returns the Paris week bounds and the 10:00 Paris payrun instant in UTC', () => {
    const schedule = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-09-21') })
    // semaine du 14 au 20 septembre en heure d'été (UTC+2) : [dimanche 13 22:00Z, dimanche 20 22:00Z)
    expect(schedule.periodStart.toISOString()).toBe('2026-09-13T22:00:00.000Z'); expect(schedule.periodEnd.toISOString()).toBe('2026-09-20T22:00:00.000Z')
    expect(schedule.payrunAtUtc.toISOString()).toBe('2026-10-02T08:00:00.000Z') // 10:00 Europe/Paris = 08:00Z
    const custom = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-09-21'), payrunLocalHour: 14 })
    expect(custom.payrunAtUtc.toISOString()).toBe('2026-10-02T12:00:00.000Z')
  })
  it('uses the FR ∪ TARGET calendar for the payrun and the FR calendar for the promise by default', () => {
    // Vendredi saint 2026-04-03 : fermé TARGET seulement. Débit mercredi 04-01 ; lundi de Pâques 04-06 férié des deux.
    const schedule = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-03-30') })
    expect(schedule.debitDate).toBe('2026-04-01')
    expect(schedule.payrunDate).toBe('2026-04-14') // TARGET : 7 jours ouvrés (04-03 et 04-06 fermés) ; en FR seul ce serait 04-13
    expect(schedule.promiseDeadline).toBe('2026-04-21') // FR : 15 jours ouvrés (04-03 ouvré, 04-06 fermé) ; en TARGET ce serait 04-22
    expect(schedule.payrunClampedToDeadline).toBe(false)
  })
  it('skips a holiday debit and holidays during the seven-day delay', () => {
    const schedule = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-04-27') })
    expect(schedule.debitDate).toBe('2026-04-29'); expect(schedule.payrunDate).toBe('2026-05-12')
  })
  it('clamps a late payrun to the promise deadline', () => {
    const schedule = computeSettlementSchedule({ closingMonday: parseLocalDate('2026-09-21'), payrunDelayBusinessDays: 30 })
    expect(schedule.payrunDate).toBe('2026-10-12'); expect(schedule.payrunClampedToDeadline).toBe(true)
  })
  it('rejects a non-Monday closing date', () => expect(() => computeSettlementSchedule({ closingMonday: parseLocalDate('2026-09-22') })).toThrow())
})
