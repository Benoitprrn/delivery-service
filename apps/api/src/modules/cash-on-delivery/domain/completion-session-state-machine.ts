import { InvalidCompletionSessionTransitionError } from './errors.js'

export type CompletionSessionStatus = 'open' | 'code_verified' | 'payment_pending' | 'payment_succeeded' | 'completed' | 'abandoned' | 'expired'

const transitions: Record<CompletionSessionStatus, readonly CompletionSessionStatus[]> = {
  open: ['code_verified', 'abandoned', 'expired'], code_verified: ['payment_pending', 'abandoned', 'expired'],
  payment_pending: ['payment_succeeded', 'abandoned', 'expired'], payment_succeeded: ['completed', 'abandoned', 'expired'],
  completed: [], abandoned: [], expired: []
}
export function canTransitionCompletionSession(from: CompletionSessionStatus, to: CompletionSessionStatus): boolean { return transitions[from].includes(to) }
export function assertCompletionSessionTransition(from: CompletionSessionStatus, to: CompletionSessionStatus): void { if (!canTransitionCompletionSession(from, to)) throw new InvalidCompletionSessionTransitionError(`Completion session transition from ${from} to ${to} is not allowed`) }
