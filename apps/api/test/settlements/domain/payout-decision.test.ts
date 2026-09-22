import { describe, expect, it } from 'vitest'
import { decideStatementPayout } from '../../../src/modules/settlements/public.js'

const at = new Date('2026-10-02T08:00:00.000Z')
const base = { dueCents: 100, paidCents: 0, debit: { classification: 'succeeded' as const, chargeId: 'ch_1', chargeAmountCents: 100, alreadyTransferredFromChargeCents: 0 }, driverAccount: { transfersActive: true }, now: at, payrunAt: at }
describe('payout decision', () => {
  it.each([
    [{ ...base, paidCents: 100 }, 'nothing_due'], [{ ...base, debit: null }, 'no_debit'], [{ ...base, debit: { ...base.debit!, classification: 'processing' } }, 'processing'], [{ ...base, debit: { ...base.debit!, classification: 'failed' } }, 'unpaid_restaurant'], [{ ...base, now: new Date(at.getTime() - 1) }, 'held_until_payrun'], [{ ...base, driverAccount: { transfersActive: false } }, 'blocked_driver_account'], [{ ...base, debit: { ...base.debit!, alreadyTransferredFromChargeCents: 100 } }, 'charge_exhausted'],
  ] as const)('waits with %s rule', (input, reason) => expect(decideStatementPayout(input)).toEqual({ action: 'wait', reason }))
  it('allows exactly at payrun and limits a partial regularization to the charge ceiling', () => {
    expect(decideStatementPayout(base)).toEqual({ action: 'transfer', amountCents: 100, chargeId: 'ch_1' })
    expect(decideStatementPayout({ ...base, dueCents: 120, paidCents: 20, debit: { ...base.debit, chargeAmountCents: 70, alreadyTransferredFromChargeCents: 30 } })).toEqual({ action: 'transfer', amountCents: 40, chargeId: 'ch_1' })
  })
})
