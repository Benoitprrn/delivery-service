import { describe, expect, it } from 'vitest'
import { driverStatementDisplayState, expectedPaymentAt, incidentOpenCents, merchantAttemptOutcome, merchantDisplayState, summarizeDriverPeriod, sumTotals } from '../../src/modules/settlements/domain/settlement-display.js'
import type { DriverStatementRow, MerchantSettlementRow } from '../../src/modules/settlements/ports/settlement-read.js'

const statement = (overrides: Partial<DriverStatementRow> = {}): DriverStatementRow => ({ statementId: 'statement', merchantId: 'merchant', dueCents: 100, paidCents: 0, status: 'unpaid', holdReason: null, settlementStatus: 'notified', debit: null, incidentOpen: false, ...overrides })
const merchant = (overrides: Partial<MerchantSettlementRow> = {}): MerchantSettlementRow => ({ merchantSettlementId: 'settlement', periodStart: new Date('2026-09-14T22:00:00.000Z'), periodEnd: new Date('2026-09-21T22:00:00.000Z'), amountCents: 100, deliveryCents: 80, serviceFeeCents: 20, deliveriesCount: 1, status: 'created', preNotification: null, attempts: [], incidents: [], openReceivablesCents: 0, retryRequested: false, ...overrides })

describe('settlement display domain', () => {
  it.each([
    ['paid first', statement({ paidCents: 100, status: 'blocked_driver_account', settlementStatus: 'technical_hold', incidentOpen: true }), 'sent_to_account'],
    ['blocked account', statement({ status: 'blocked_driver_account' }), 'account_action_required'],
    ['technical hold before incident and restaurant default', statement({ settlementStatus: 'technical_hold', status: 'unpaid_restaurant', incidentOpen: true }), 'awaiting_debit'],
    ['incident', statement({ incidentOpen: true }), 'restaurant_incident'],
    ['incident hold reason', statement({ holdReason: 'debit_incident' }), 'restaurant_incident'],
    ['restaurant default', statement({ status: 'unpaid_restaurant' }), 'awaiting_restaurant_payment'],
    ['partial payment', statement({ paidCents: 10, status: 'partial' }), 'payment_delayed'],
    ['succeeded held', statement({ status: 'succeeded_held' }), 'collected_payment_scheduled'],
    ['succeeded held with hold', statement({ status: 'succeeded_held', holdReason: 'retry' }), 'payment_delayed'],
    ['debit processing', statement({ status: 'waiting_sepa', debit: { attemptNo: 1, status: 'processing' } }), 'debit_in_progress'],
    ['awaiting debit', statement(), 'awaiting_debit']
  ])('%s', (_name, input, output) => expect(driverStatementDisplayState(input)).toBe(output))

  it('computes period and global integer-cent totals, including restaurant debt', () => {
    const first = summarizeDriverPeriod([{ dueCents: 100, paidCents: 100, displayState: 'sent_to_account' }, { dueCents: 90, paidCents: 20, displayState: 'awaiting_restaurant_payment' }, { dueCents: 50, paidCents: 0, displayState: 'restaurant_incident' }])
    expect(first).toEqual({ totalCents: 240, sentCents: 120, pendingCents: 120, unpaidByRestaurantCents: 120 })
    expect(sumTotals([first, { totalCents: 10, sentCents: 0, pendingCents: 10, unpaidByRestaurantCents: 0 }])).toEqual({ totalCents: 250, sentCents: 120, pendingCents: 130, unpaidByRestaurantCents: 120 })
  })

  it('only gives a payment date to eligible unresolved states', () => {
    const payrun = new Date('2026-09-22T08:00:00.000Z')
    expect(expectedPaymentAt('awaiting_debit', payrun)).toBe(payrun.toISOString())
    expect(expectedPaymentAt('payment_delayed', payrun)).toBe(payrun.toISOString())
    expect(expectedPaymentAt('sent_to_account', payrun)).toBeNull()
    expect(expectedPaymentAt('restaurant_incident', payrun)).toBeNull()
  })

  it.each([
    ['incident wins', merchant({ status: 'failed', retryRequested: true, incidents: [{ kind: 'dispute', amountCents: 1, status: 'open' }] }), 'incident'],
    ['retry', merchant({ retryRequested: true }), 'retry_scheduled'], ['paid', merchant({ status: 'succeeded' }), 'paid'], ['failed', merchant({ status: 'failed' }), 'failed'], ['technical', merchant({ status: 'technical_hold' }), 'technical_review'], ['processing', merchant({ status: 'debit_processing' }), 'debit_in_progress'], ['notified', merchant({ status: 'notified' }), 'notified'], ['awaiting', merchant(), 'awaiting_notification']
  ])('merchant state: %s', (_name, row, output) => expect(merchantDisplayState(row)).toBe(output))

  it('maps attempt outcomes and counts only open/lost/refund incidents', () => {
    expect(['creating', 'processing', 'succeeded', 'failed', 'canceled', 'technical_error'].map((status) => merchantAttemptOutcome(status as Parameters<typeof merchantAttemptOutcome>[0]))).toEqual(['in_progress', 'in_progress', 'succeeded', 'failed', 'failed', 'technical'])
    expect(incidentOpenCents([{ kind: 'dispute', amountCents: 10, status: 'won' }, { kind: 'dispute', amountCents: 20, status: 'lost' }, { kind: 'refund', amountCents: 30, status: 'closed' }])).toBe(50)
  })
})
