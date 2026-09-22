import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { OrderConflictError, type Actor } from '../../orders/public.js'
import {
  assertCashOnDeliveryPaymentTransition,
  type CashOnDeliveryPaymentStatus
} from '../domain/cash-on-delivery-payment-state-machine.js'
import {
  COD_RECONCILIATION_BATCH_SIZE,
  defaultCashOnDeliveryReconciliationPolicy,
  type CashOnDeliveryReconciliationPolicy
} from '../domain/reconciliation-policy.js'
import type { CashOnDeliveryReconciliationRepository, ReconciliationSubject } from '../ports/cash-on-delivery-reconciliation-repository.js'
import {
  ConnectResourceMissingError,
  PaymentIntentUnexpectedStateError,
  type ConnectPaymentsProvider,
  type TerminalPaymentIntent
} from '../ports/connect-payments-provider.js'
import { ACTIVE_PAYMENT_STATUSES, decideReconciliation, type ReconciliationDecision } from './reconciliation-decision.js'

export interface CashOnDeliveryReconciliationLogger {
  info(object: Record<string, unknown>, message: string): void
  warn(object: Record<string, unknown>, message: string): void
  error(object: Record<string, unknown>, message: string): void
}

export const noopCashOnDeliveryReconciliationLogger: CashOnDeliveryReconciliationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

/** Participant `orders` : uniquement ce dont la réconciliation a besoin. */
export type ReconciliationOrdersPort = {
  completeCollectedCashOnDeliveryInTransaction(
    client: PoolClient,
    input: { orderId: string; driverId: string; expectedVersion: number; actor: Actor; correlationId: string }
  ): Promise<unknown>
  releaseDriverCapacity(driverId: string): Promise<unknown>
}

export type ReconcileOutcome =
  /** Commande `COMPLETED`, paiement `captured`, session `completed`. */
  | 'completed'
  /** Décision humaine requise (encaissement non complétable, PaymentIntent suspect...). Rien n'a été forcé. */
  | 'needs_review'
  | 'authorized'
  | 'canceled'
  | 'failed'
  | 'marked_unknown'
  /** Stripe n'a pas tranché, ou l'état local a changé pendant l'analyse. */
  | 'unchanged'
  | 'already_final'
  | 'not_found'

export type ReconciliationRunSummary = {
  claimed: number
  failures: number
  outcomes: Partial<Record<ReconcileOutcome, number>>
}

export type CashOnDeliveryReconciliationDependencies = {
  repository: CashOnDeliveryReconciliationRepository
  provider: ConnectPaymentsProvider
  orders: ReconciliationOrdersPort
  logger?: CashOnDeliveryReconciliationLogger
  policy?: CashOnDeliveryReconciliationPolicy
}

const SYSTEM_ACTOR: Actor = { type: 'system' }

/**
 * Réconciliation des paiements COD dont l'état local peut diverger de Stripe
 * (app livreur tuée, coupure réseau, crash entre capture et commit, autorisation
 * abandonnée). Ne capture JAMAIS : la capture reste celle de `finalize`. Aucun appel
 * Stripe ne se fait à l'intérieur d'une transaction PostgreSQL.
 */
export class CashOnDeliveryReconciliation {
  private readonly repository: CashOnDeliveryReconciliationRepository
  private readonly provider: ConnectPaymentsProvider
  private readonly orders: ReconciliationOrdersPort
  private readonly logger: CashOnDeliveryReconciliationLogger
  private readonly policy: CashOnDeliveryReconciliationPolicy

  constructor(dependencies: CashOnDeliveryReconciliationDependencies) {
    this.repository = dependencies.repository
    this.provider = dependencies.provider
    this.orders = dependencies.orders
    this.logger = dependencies.logger ?? noopCashOnDeliveryReconciliationLogger
    this.policy = dependencies.policy ?? defaultCashOnDeliveryReconciliationPolicy
  }

  /** Un cycle : réserve un lot de paiements périmés puis les réconcilie, chacun isolé. */
  async reconcileCashOnDeliveryPayments(limit: number = COD_RECONCILIATION_BATCH_SIZE): Promise<ReconciliationRunSummary> {
    const claimed = await this.repository.claimStale({ limit, policy: this.policy })
    const summary: ReconciliationRunSummary = { claimed: claimed.length, failures: 0, outcomes: {} }
    for (const subject of claimed) {
      try {
        const outcome = await this.reconcile(subject, 0)
        summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1
      } catch (error) {
        summary.failures += 1
        // Le paiement reste actif ; le bail (`updated_at`) le repousse au prochain délai de reprise.
        this.logger.error(
          {
            event: 'cod_reconciliation_payment_failed',
            paymentId: subject.payment.id,
            orderId: subject.payment.orderId,
            errorClass: error instanceof Error ? error.constructor.name : 'UnknownError'
          },
          'Cash on delivery payment reconciliation failed'
        )
      }
    }
    if (summary.claimed > 0) this.logger.info({ event: 'cod_reconciliation_cycle', ...summary }, 'Cash on delivery reconciliation cycle done')
    return summary
  }

  /**
   * Réconcilie le paiement local portant ce PaymentIntent (appelé par les webhooks
   * Connect). Sans bail : chaque mutation est un compare-and-set sur le statut, donc un
   * worker concurrent ou `finalize` ne peuvent produire qu'un seul résultat.
   */
  async reconcilePaymentIntent(paymentIntentId: string): Promise<ReconcileOutcome> {
    const subject = await this.repository.findByPaymentIntentId(paymentIntentId, this.policy)
    if (subject === null) return 'not_found'
    return this.reconcile(subject, 0)
  }

  private async reconcile(subject: ReconciliationSubject, depth: number): Promise<ReconcileOutcome> {
    const { payment } = subject
    if (payment.status === 'captured') return 'already_final'
    if (payment.stripePaymentIntentId === null) return this.reconcileWithoutIntent(subject)

    let intent: TerminalPaymentIntent
    try {
      intent = await this.provider.retrievePaymentIntent({ accountId: payment.stripeAccountId, paymentIntentId: payment.stripePaymentIntentId })
    } catch (error) {
      if (error instanceof ConnectResourceMissingError) return this.reconcileMissingIntent(subject)
      throw error
    }

    const decision = decideReconciliation({ payment, intent, sessionAbandoned: subject.sessionAbandoned })
    return this.apply(subject, intent, decision, depth)
  }

  private async apply(subject: ReconciliationSubject, intent: TerminalPaymentIntent, decision: ReconciliationDecision, depth: number): Promise<ReconcileOutcome> {
    const { payment } = subject
    switch (decision.kind) {
      case 'contaminated': {
        this.logger.error(
          {
            event: 'cod_reconciliation_payment_intent_mismatch',
            securityAlert: true,
            paymentId: payment.id,
            orderId: payment.orderId,
            paymentIntentId: payment.stripePaymentIntentId,
            intentStatus: intent.status,
            mismatches: decision.mismatches
          },
          'Stripe PaymentIntent does not match the local cash on delivery payment; never completing it'
        )
        if (payment.status === 'failed' || payment.status === 'canceled') return 'needs_review'
        await this.transition(payment.id, ACTIVE_PAYMENT_STATUSES, 'unknown')
        return 'marked_unknown'
      }
      case 'complete_captured':
        return this.completeCaptured(subject, intent)
      case 'captured_on_terminal_payment':
        this.logger.error(
          {
            event: 'cod_reconciliation_captured_on_terminal_payment',
            manualReviewRequired: true,
            paymentId: payment.id,
            orderId: payment.orderId,
            paymentIntentId: payment.stripePaymentIntentId,
            localStatus: payment.status
          },
          'Stripe captured a PaymentIntent whose local payment is already failed or canceled; not forcing anything'
        )
        return 'needs_review'
      case 'mark_authorized':
        return (await this.transition(payment.id, ['intent_created', 'processing', 'unknown'], 'authorized')) ? 'authorized' : 'unchanged'
      case 'mark_canceled':
        return (await this.transition(payment.id, ACTIVE_PAYMENT_STATUSES, 'canceled')) ? 'canceled' : 'unchanged'
      case 'cancel_intent':
        return this.cancelIntent(subject, intent, decision.local, depth)
      case 'wait':
        return 'unchanged'
    }
  }

  private async cancelIntent(
    subject: ReconciliationSubject,
    intent: TerminalPaymentIntent,
    local: 'canceled' | 'failed' | null,
    depth: number
  ): Promise<ReconcileOutcome> {
    const { payment } = subject
    // Dernier garde-fou avant d'annuler une autorisation : la session a pu être reprise
    // par le livreur, ou le paiement changer d'état, depuis le claim.
    const fresh = await this.repository.findByPaymentId(payment.id, this.policy)
    if (fresh === null) return 'unchanged'
    const stillCancellable = local === null
      ? fresh.payment.status === 'failed' || fresh.payment.status === 'canceled'
      : ACTIVE_PAYMENT_STATUSES.includes(fresh.payment.status) && fresh.sessionAbandoned
    if (!stillCancellable) return 'unchanged'

    try {
      await this.provider.cancelPaymentIntent({
        accountId: payment.stripeAccountId,
        paymentIntentId: intent.id,
        idempotencyKey: `cod-cancel-${payment.id}`
      })
    } catch (error) {
      if (error instanceof ConnectResourceMissingError) return this.reconcileMissingIntent(subject)
      if (error instanceof PaymentIntentUnexpectedStateError) {
        // Capturé ou annulé entre la lecture et l'annulation : relire puis décider, une seule fois.
        if (depth >= 1) {
          this.logger.warn({ event: 'cod_reconciliation_cancel_rejected_twice', paymentId: payment.id }, 'Stripe rejected the PaymentIntent cancellation twice; retrying later')
          return 'unchanged'
        }
        return this.reconcile(subject, depth + 1)
      }
      throw error
    }

    if (local === null) return 'canceled'
    const applied = local === 'failed'
      ? await this.transition(payment.id, ACTIVE_PAYMENT_STATUSES, 'failed', { failureCode: intent.lastPaymentErrorCode, declineCode: intent.lastPaymentErrorDeclineCode })
      : await this.transition(payment.id, ACTIVE_PAYMENT_STATUSES, 'canceled')
    return applied ? local : 'unchanged'
  }

  private async completeCaptured(subject: ReconciliationSubject, intent: TerminalPaymentIntent): Promise<ReconcileOutcome> {
    const { payment, session } = subject
    const correlationId = randomUUID()
    let result: 'completed' | 'payment_not_active'
    try {
      result = await this.repository.completeCapturedPayment({
        paymentId: payment.id,
        sessionId: session.id,
        chargeId: intent.chargeId,
        completeOrder: (client) => this.orders.completeCollectedCashOnDeliveryInTransaction(client, {
          orderId: payment.orderId,
          driverId: payment.driverId,
          expectedVersion: session.expectedOrderVersion,
          actor: SYSTEM_ACTOR,
          correlationId
        })
      })
    } catch (error) {
      if (!(error instanceof OrderConflictError)) throw error
      return this.recordCaptureWithoutCompletion(subject, intent)
    }

    if (result === 'payment_not_active') {
      const current = await this.repository.findByPaymentId(payment.id, this.policy)
      if (current?.payment.status === 'captured') return 'already_final'
      this.logger.error(
        {
          event: 'cod_reconciliation_captured_on_terminal_payment',
          manualReviewRequired: true,
          paymentId: payment.id,
          orderId: payment.orderId,
          paymentIntentId: intent.id,
          localStatus: current?.payment.status ?? null
        },
        'Stripe captured a PaymentIntent whose local payment is no longer active; not forcing anything'
      )
      return 'needs_review'
    }

    try {
      await this.orders.releaseDriverCapacity(payment.driverId)
    } catch (error) {
      this.logger.warn(
        { event: 'cod_reconciliation_release_capacity_failed', paymentId: payment.id, errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' },
        'Driver capacity release failed after a reconciled completion'
      )
    }
    this.logger.info({ event: 'cod_reconciliation_completed', paymentId: payment.id, orderId: payment.orderId }, 'Cash on delivery order completed by reconciliation')
    return 'completed'
  }

  /**
   * L'argent est capturé mais la commande n'est plus complétable (plus `COLLECTED`, version
   * ou livreur changés) : la vérité Stripe est enregistrée sur le paiement, la commande est
   * laissée intacte et un humain tranche (remboursement ou régularisation).
   */
  private async recordCaptureWithoutCompletion(subject: ReconciliationSubject, intent: TerminalPaymentIntent): Promise<ReconcileOutcome> {
    const { payment } = subject
    const recorded = await this.repository.recordCaptureWithoutCompletion({ paymentId: payment.id, chargeId: intent.chargeId })
    if (recorded === 'payment_not_active') return 'already_final'
    this.logger.error(
      {
        event: 'cod_reconciliation_captured_order_not_completable',
        manualReviewRequired: true,
        reason: recorded === 'duplicate_capture' ? 'another_payment_already_captured_for_order' : 'order_not_collectable',
        paymentId: payment.id,
        orderId: payment.orderId,
        paymentIntentId: intent.id
      },
      'Stripe captured this PaymentIntent but the order can no longer be completed; human review required'
    )
    return 'needs_review'
  }

  /** Aucun PaymentIntent enregistré : la création n'a pas abouti localement, rien à capturer. */
  private async reconcileWithoutIntent(subject: ReconciliationSubject): Promise<ReconcileOutcome> {
    if (!subject.sessionAbandoned) return 'unchanged'
    const applied = await this.transition(subject.payment.id, ['created', 'intent_created'], 'canceled')
    if (!applied) return 'unchanged'
    this.logger.warn(
      { event: 'cod_reconciliation_payment_without_intent', paymentId: subject.payment.id, orderId: subject.payment.orderId },
      'Abandoned payment had no recorded PaymentIntent; canceled locally'
    )
    return 'canceled'
  }

  private async reconcileMissingIntent(subject: ReconciliationSubject): Promise<ReconcileOutcome> {
    const { payment } = subject
    this.logger.error(
      { event: 'cod_reconciliation_payment_intent_missing', paymentId: payment.id, orderId: payment.orderId, paymentIntentId: payment.stripePaymentIntentId },
      'Stripe PaymentIntent is missing on the merchant account; payment marked failed, nothing completed'
    )
    if (payment.status === 'failed' || payment.status === 'canceled') return 'unchanged'
    return (await this.transition(payment.id, ACTIVE_PAYMENT_STATUSES, 'failed', { failureCode: 'resource_missing', declineCode: null })) ? 'failed' : 'unchanged'
  }

  private async transition(
    paymentId: string,
    from: readonly CashOnDeliveryPaymentStatus[],
    to: CashOnDeliveryPaymentStatus,
    codes: { failureCode: string | null; declineCode: string | null } = { failureCode: null, declineCode: null }
  ): Promise<boolean> {
    for (const status of from) {
      if (status !== to) assertCashOnDeliveryPaymentTransition(status, to)
    }
    return this.repository.transitionPayment({ paymentId, from, to, failureCode: codes.failureCode, declineCode: codes.declineCode })
  }
}

export type CashOnDeliveryReconciliationApi = {
  reconcileCashOnDeliveryPayments: (limit?: number) => Promise<ReconciliationRunSummary>
  reconcilePaymentIntent: (paymentIntentId: string) => Promise<ReconcileOutcome>
}

export function createCashOnDeliveryReconciliation(dependencies: CashOnDeliveryReconciliationDependencies): CashOnDeliveryReconciliationApi {
  const reconciliation = new CashOnDeliveryReconciliation(dependencies)
  return {
    reconcileCashOnDeliveryPayments: (limit) => reconciliation.reconcileCashOnDeliveryPayments(limit),
    reconcilePaymentIntent: (paymentIntentId) => reconciliation.reconcilePaymentIntent(paymentIntentId)
  }
}
