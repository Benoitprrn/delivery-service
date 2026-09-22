import type { CompletionSessionStatus } from '../domain/completion-session-state-machine.js'

export type CompletionSession = { id: string; orderId: string; driverId: string; expectedOrderVersion: number; status: CompletionSessionStatus; codeVerifiedAt: Date | null; expiresAt: Date; completedAt: Date | null }
export type CreateOrResumeCompletionSession = { orderId: string; driverId: string; expectedOrderVersion: number; expiresAt: Date }
export interface CompletionSessionRepository {
  createOrResume(input: CreateOrResumeCompletionSession): Promise<CompletionSession>
  findByOrderId(orderId: string): Promise<CompletionSession | null>
  transition(input: { id: string; from: readonly CompletionSessionStatus[]; to: CompletionSessionStatus }): Promise<CompletionSession>
}
