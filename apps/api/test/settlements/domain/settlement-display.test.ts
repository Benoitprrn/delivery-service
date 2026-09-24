import { describe, expect, it } from 'vitest'
import { driverStatementDisplayState, expectedPaymentAt, incidentOpenCents, merchantAttemptOutcome, merchantDisplayState, summarizeDriverPeriod, sumTotals } from '../../../src/modules/settlements/domain/settlement-display.js'

const statement = (overrides = {}) => ({ status: 'waiting_sepa' as const, dueCents: 100, paidCents: 0, holdReason: null, settlementStatus: 'x', debit: null, incidentOpen: false, ...overrides })
const merchant = (overrides = {}) => ({ merchantSettlementId: 'id', periodStart: new Date('2026-01-01Z'), periodEnd: new Date('2026-01-08Z'), amountCents: 1, deliveryCents: 1, serviceFeeCents: 0, deliveriesCount: 1, status: 'closed', preNotification: null, attempts: [], incidents: [], openReceivablesCents: 0, retryRequested: false, ...overrides })

describe('settlement display', () => {
  it('applies driver priorities, including technical holds', () => {
    expect(driverStatementDisplayState(statement({ paidCents: 100, status: 'blocked_driver_account' }))).toBe('sent_to_account')
    expect(driverStatementDisplayState(statement({ status: 'blocked_driver_account' }))).toBe('account_action_required')
    expect(driverStatementDisplayState(statement({ status: 'technical_hold' }))).toBe('awaiting_debit')
    expect(driverStatementDisplayState(statement({ status: 'unpaid_restaurant', incidentOpen: true }))).toBe('restaurant_incident')
    expect(driverStatementDisplayState(statement({ status: 'unpaid_restaurant' }))).toBe('awaiting_restaurant_payment')
    expect(driverStatementDisplayState(statement({ paidCents: 1 }))).toBe('payment_delayed')
    expect(driverStatementDisplayState(statement({ status: 'succeeded_held' }))).toBe('collected_payment_scheduled')
    expect(driverStatementDisplayState(statement({ status: 'succeeded_held', holdReason: 'transfer_retry' }))).toBe('payment_delayed')
    expect(driverStatementDisplayState(statement({ debit: { status: 'processing' } }))).toBe('debit_in_progress')
  })
  it('never blames the restaurant for a technical hold of the settlement (Locadely-side incident)', () => {
    expect(driverStatementDisplayState(statement({ status: 'waiting_sepa', settlementStatus: 'technical_hold' }))).toBe('awaiting_debit')
    expect(driverStatementDisplayState(statement({ status: 'unpaid', settlementStatus: 'technical_hold', debit: { status: 'technical_error' } }))).toBe('awaiting_debit')
    expect(driverStatementDisplayState(statement({ status: 'unpaid_restaurant', settlementStatus: 'failed' }))).toBe('awaiting_restaurant_payment')
    expect(driverStatementDisplayState(statement({ status: 'blocked_driver_account', settlementStatus: 'technical_hold' }))).toBe('account_action_required')
    expect(driverStatementDisplayState(statement({ status: 'paid', paidCents: 100, settlementStatus: 'technical_hold' }))).toBe('sent_to_account')
    expect(driverStatementDisplayState(statement({ status: 'succeeded_held', holdReason: 'debit_incident' }))).toBe('restaurant_incident')
  })
  it('summarizes exact cents and dates', () => {
    const total = summarizeDriverPeriod([{ dueCents: 100, paidCents: 20, displayState: 'awaiting_restaurant_payment' as const }, { dueCents: 50, paidCents: 50, displayState: 'sent_to_account' as const }])
    expect(total).toEqual({ totalCents: 150, sentCents: 70, pendingCents: 80, unpaidByRestaurantCents: 80 })
    expect(sumTotals([total, total]).totalCents).toBe(300)
    expect(expectedPaymentAt('payment_delayed', new Date('2026-01-01Z'))).toBe('2026-01-01T00:00:00.000Z')
  })
  it('applies merchant states, attempts and incidents', () => {
    expect(merchantDisplayState(merchant({ status: 'succeeded', incidents: [{ kind: 'refund', amountCents: 2, status: 'closed' }] }))).toBe('incident')
    expect(merchantDisplayState(merchant({ retryRequested: true }))).toBe('retry_scheduled')
    expect(merchantDisplayState(merchant({ status: 'technical_hold' }))).toBe('technical_review')
    expect(merchantAttemptOutcome('technical_error')).toBe('technical')
    expect(incidentOpenCents([{ kind: 'dispute', amountCents: 2, status: 'won' }, { kind: 'refund', amountCents: 3, status: 'closed' }, { kind: 'dispute', amountCents: 4, status: 'open' }])).toBe(7)
  })
})
