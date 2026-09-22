import type { PoolClient } from 'pg'
import type { CashOnDeliveryPaymentStatus } from '../domain/cash-on-delivery-payment-state-machine.js'
import type { CashOnDeliveryReconciliationPolicy } from '../domain/reconciliation-policy.js'
import type { CompletionSessionStatus } from '../domain/completion-session-state-machine.js'
import type { CashOnDeliveryPayment } from './cash-on-delivery-payment-repository.js'

/** Un paiement local, sa session et l'état d'abandon calculé avec l'horloge PostgreSQL. */
export type ReconciliationSubject = {
  payment: CashOnDeliveryPayment
  session: {
    id: string
    status: CompletionSessionStatus
    expiresAt: Date
    expectedOrderVersion: number
  }
  /** Session expirée depuis plus que le délai de grâce. */
  sessionAbandoned: boolean
}

export type CompleteCapturedPaymentResult = 'completed' | 'payment_not_active'
export type RecordCaptureWithoutCompletionResult = 'recorded' | 'payment_not_active' | 'duplicate_capture'

export interface CashOnDeliveryReconciliationRepository {
  /**
   * Réserve jusqu'à `limit` paiements à réconcilier : `FOR UPDATE SKIP LOCKED`
   * puis remise de `updated_at` à `now()` (bail), en une seule instruction.
   */
  claimStale(input: { limit: number; policy: CashOnDeliveryReconciliationPolicy }): Promise<ReconciliationSubject[]>
  findByPaymentIntentId(paymentIntentId: string, policy: CashOnDeliveryReconciliationPolicy): Promise<ReconciliationSubject | null>
  findByPaymentId(paymentId: string, policy: CashOnDeliveryReconciliationPolicy): Promise<ReconciliationSubject | null>
  /** Compare-and-set sur le statut ; `false` si le paiement a changé entre-temps. */
  transitionPayment(input: {
    paymentId: string
    from: readonly CashOnDeliveryPaymentStatus[]
    to: CashOnDeliveryPaymentStatus
    failureCode?: string | null
    declineCode?: string | null
  }): Promise<boolean>
  /**
   * UNE transaction : paiement `captured`, session `completed` et, via
   * `completeOrder` (participant `orders`), commande `COMPLETED`. Toute exception de
   * `completeOrder` annule l'ensemble. Aucun appel réseau à l'intérieur.
   */
  completeCapturedPayment(input: {
    paymentId: string
    sessionId: string
    chargeId: string | null
    completeOrder: (client: PoolClient) => Promise<unknown>
  }): Promise<CompleteCapturedPaymentResult>
  /** Enregistre l'encaissement Stripe sans toucher à la commande (revue humaine requise). */
  recordCaptureWithoutCompletion(input: { paymentId: string; chargeId: string | null }): Promise<RecordCaptureWithoutCompletionResult>
}
