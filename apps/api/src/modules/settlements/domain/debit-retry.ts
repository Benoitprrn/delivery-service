import { InvalidAmountError, InvalidRetryAttemptError } from './errors.js'

export type RetryAttemptSummary = { attemptNo: number; status: 'creating' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'technical_error' }
export type DebitRetryDecision =
  | { allowed: true; nextAttemptNo: number; cause: 'failed_debit' | 'technical_error'; freshPreNotificationRequired: true }
  | { allowed: false; reason: 'no_attempt' | 'settlement_zero' | 'debit_in_flight' | 'debit_already_succeeded' | 'open_retry_request' | 'max_attempts_reached' }

export function decideDebitRetry(input: { settlementAmountCents: number; attempts: readonly RetryAttemptSummary[]; hasOpenRetryRequest: boolean; maxAttempts?: number }): DebitRetryDecision {
  if (!Number.isSafeInteger(input.settlementAmountCents)) throw new InvalidAmountError()
  const maxAttempts = input.maxAttempts ?? 5
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new InvalidRetryAttemptError('Maximum attempts must be a positive safe integer')
  const seen = new Set<number>()
  for (const attempt of input.attempts) {
    if (!Number.isSafeInteger(attempt.attemptNo) || attempt.attemptNo < 1 || seen.has(attempt.attemptNo)) throw new InvalidRetryAttemptError()
    seen.add(attempt.attemptNo)
  }
  if (input.settlementAmountCents <= 0) return { allowed: false, reason: 'settlement_zero' }
  if (input.attempts.length === 0) return { allowed: false, reason: 'no_attempt' }
  if (input.attempts.some((attempt) => attempt.status === 'succeeded')) return { allowed: false, reason: 'debit_already_succeeded' }
  if (input.attempts.some((attempt) => attempt.status === 'creating' || attempt.status === 'processing')) return { allowed: false, reason: 'debit_in_flight' }
  if (input.hasOpenRetryRequest) return { allowed: false, reason: 'open_retry_request' }
  if (input.attempts.length >= maxAttempts) return { allowed: false, reason: 'max_attempts_reached' }
  const latest = input.attempts.reduce((current, attempt) => attempt.attemptNo > current.attemptNo ? attempt : current)
  return { allowed: true, nextAttemptNo: latest.attemptNo + 1, cause: latest.status === 'technical_error' ? 'technical_error' : 'failed_debit', freshPreNotificationRequired: true }
}
