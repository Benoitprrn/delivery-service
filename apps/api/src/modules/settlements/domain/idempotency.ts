import { InvalidIdempotencyKeyInputError } from './errors.js'

export type TransferAttemptOutcome = 'unknown' | 'definitive_4xx'
export function buildTransferIdempotencyKey(input: { statementId: string; chargeId: string; tryNo: number }): string {
  if (!input.statementId || !input.chargeId || input.statementId.includes(':') || input.chargeId.includes(':') || !Number.isSafeInteger(input.tryNo) || input.tryNo < 1) throw new InvalidIdempotencyKeyInputError()
  return `stmt:${input.statementId}:charge:${input.chargeId}:try:${input.tryNo}`
}
export function nextTryNo(previousAttempts: number, outcome: TransferAttemptOutcome): number {
  if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 1) throw new InvalidIdempotencyKeyInputError()
  return outcome === 'definitive_4xx' ? previousAttempts + 1 : previousAttempts
}
