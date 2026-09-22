import { describe, expect, it } from 'vitest'
import { deriveStatementStatus, transitionStatementStatus, type StatementPayoutDecision } from '../../../src/modules/settlements/public.js'

const wait = (reason: Extract<StatementPayoutDecision, { action: 'wait' }>['reason']): StatementPayoutDecision => ({ action: 'wait', reason })
describe('statement status', () => {
  it('derives terminal and partial statuses exclusively from paid amounts', () => {
    expect(deriveStatementStatus({ dueCents: 100, paidCents: 100, decision: wait('processing') })).toBe('paid')
    expect(deriveStatementStatus({ dueCents: 100, paidCents: 1, decision: wait('unpaid_restaurant') })).toBe('partial')
    expect(() => deriveStatementStatus({ dueCents: 100, paidCents: 101, decision: wait('processing') })).toThrow()
  })
  it.each([['processing', 'waiting_sepa'], ['held_until_payrun', 'succeeded_held'], ['unpaid_restaurant', 'unpaid_restaurant'], ['blocked_driver_account', 'blocked_driver_account']] as const)('maps wait reason %s', (reason, status) => expect(deriveStatementStatus({ dueCents: 100, paidCents: 0, decision: wait(reason) })).toBe(status))
  it('is paid only when paid equals due exactly, even one cent short', () => {
    expect(deriveStatementStatus({ dueCents: 100, paidCents: 99, decision: wait('processing') })).toBe('partial')
    expect(deriveStatementStatus({ dueCents: 1, paidCents: 0, decision: wait('processing') })).toBe('waiting_sepa')
  })
  it('forbids a terminal paid statement from reverting', () => {
    expect(() => transitionStatementStatus('paid', 'partial')).toThrow()
    expect(transitionStatementStatus('paid', 'paid')).toBe('paid')
  })
})
