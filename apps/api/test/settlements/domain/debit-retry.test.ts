import { describe, expect, it } from 'vitest'
import { decideDebitRetry, InvalidRetryAttemptError } from '../../../src/modules/settlements/public.js'

const failed = { attemptNo: 1, status: 'failed' as const }
describe('manual debit retry', () => {
  it.each([
    [{ settlementAmountCents: 0, attempts: [], hasOpenRetryRequest: false }, 'settlement_zero'],
    [{ settlementAmountCents: 1, attempts: [], hasOpenRetryRequest: false }, 'no_attempt'],
    [{ settlementAmountCents: 1, attempts: [{ attemptNo: 1, status: 'succeeded' as const }], hasOpenRetryRequest: false }, 'debit_already_succeeded'],
    [{ settlementAmountCents: 1, attempts: [{ attemptNo: 1, status: 'processing' as const }], hasOpenRetryRequest: false }, 'debit_in_flight'],
    [{ settlementAmountCents: 1, attempts: [failed], hasOpenRetryRequest: true }, 'open_retry_request'],
    [{ settlementAmountCents: 1, attempts: [failed], hasOpenRetryRequest: false, maxAttempts: 1 }, 'max_attempts_reached']
  ])('applies refusal order: %s', (input, reason) => {
    const decision = decideDebitRetry(input)
    expect(decision.allowed ? null : decision.reason).toBe(reason)
  })
  it('allows a manual retry from the latest unsorted failed or technical attempt', () => {
    expect(decideDebitRetry({ settlementAmountCents: 1, attempts: [{ attemptNo: 4, status: 'technical_error' }, { attemptNo: 2, status: 'failed' }], hasOpenRetryRequest: false })).toEqual({ allowed: true, nextAttemptNo: 5, cause: 'technical_error', freshPreNotificationRequired: true })
    expect(decideDebitRetry({ settlementAmountCents: 1, attempts: [failed, { attemptNo: 3, status: 'canceled' }], hasOpenRetryRequest: false })).toMatchObject({ allowed: true, cause: 'failed_debit' })
  })
  it('rejects duplicate and invalid attempt numbers', () => {
    expect(() => decideDebitRetry({ settlementAmountCents: 1, attempts: [failed, failed], hasOpenRetryRequest: false })).toThrow(InvalidRetryAttemptError)
    expect(() => decideDebitRetry({ settlementAmountCents: 1, attempts: [{ attemptNo: 0, status: 'failed' }], hasOpenRetryRequest: false })).toThrow(InvalidRetryAttemptError)
  })
})
