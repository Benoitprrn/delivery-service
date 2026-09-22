import { noopPaymentsLogger, type PaymentsLogger } from '../ports/payments-logger.js'
import {
  CONNECT_SNAPSHOT_EVENT_TYPES,
  CONNECT_SUPPORTED_EVENT_TYPES,
  type ConnectWebhookDomainPorts,
  type ConnectWebhookRepository,
  type ConnectWebhookVerifier,
  type StoredConnectWebhookEvent,
  type VerifiedConnectEvent
} from '../ports/connect-webhook.js'

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_]+$/

/** Aucun paiement local ne porte ce PaymentIntent (peut précéder la persistance locale : rejouable). */
export class UnknownConnectPaymentIntentError extends Error {}
/** Aucun marchand local ne porte ce compte Stripe (peut précéder la persistance locale : rejouable). */
export class UnknownConnectAccountError extends Error {}
/** Le compte de l'événement diffère de celui du paiement local : définitif, jamais rejoué. */
export class ConnectAccountMismatchError extends Error {}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'UnknownError'
}

function isSnapshotType(type: string): boolean {
  return (CONNECT_SNAPSHOT_EVENT_TYPES as readonly string[]).includes(type)
}

/**
 * Réduit un événement vérifié à ce que le journal conserve. Renvoie un motif
 * d'ignorance lorsque l'événement ne doit pas être persisté.
 */
export function toStoredConnectEvent(
  event: VerifiedConnectEvent
): { stored: StoredConnectWebhookEvent } | { ignored: 'unsupported_type' | 'missing_account' | 'missing_object' } {
  if (!CONNECT_SUPPORTED_EVENT_TYPES.includes(event.type)) return { ignored: 'unsupported_type' }
  if (event.accountId === null || !ACCOUNT_ID_PATTERN.test(event.accountId)) return { ignored: 'missing_account' }

  if (event.style === 'thin') {
    return {
      stored: {
        eventId: event.id,
        eventType: event.type,
        accountId: event.accountId,
        objectId: event.accountId,
        paymentIntentId: null,
        merchantId: null,
        orderId: null
      }
    }
  }

  // Un snapshot ne sert qu'à déclencher : ses types sont bornés à la liste blanche.
  if (!isSnapshotType(event.type) || event.object.id === null) return { ignored: 'missing_object' }

  return {
    stored: {
      eventId: event.id,
      eventType: event.type,
      accountId: event.accountId,
      objectId: event.object.id,
      paymentIntentId: event.object.paymentIntentId,
      merchantId: event.object.metadata.merchantId,
      orderId: event.object.metadata.orderId
    }
  }
}

export class ReceiveConnectWebhookUseCase {
  constructor(
    private readonly verifier: ConnectWebhookVerifier,
    private readonly repository: ConnectWebhookRepository,
    private readonly logger: PaymentsLogger = noopPaymentsLogger
  ) {}

  /** La signature est toujours vérifiée d'abord ; seul un événement supporté est persisté (sans payload). */
  async receive(payload: string | Buffer, signature: string): Promise<void> {
    const event = this.verifier.verify(payload, signature)
    const reduced = toStoredConnectEvent(event)

    if ('ignored' in reduced) {
      const details = { eventId: event.id, eventType: event.type, reason: reduced.ignored }
      if (reduced.ignored === 'unsupported_type') {
        this.logger.debug(details, 'Ignoring unsupported Stripe Connect webhook event')
      } else {
        this.logger.warn(details, 'Ignoring Stripe Connect webhook event without usable identifiers')
      }
      return
    }

    await this.repository.record(reduced.stored)
  }
}

export class ProcessConnectWebhooksUseCase {
  constructor(
    private readonly repository: ConnectWebhookRepository,
    private readonly domain: ConnectWebhookDomainPorts,
    private readonly logger: PaymentsLogger = noopPaymentsLogger
  ) {}

  async processBatch(limit = 10): Promise<number> {
    let processed = 0

    while (processed < limit) {
      const claim = await this.repository.claimNext()
      if (claim === null) break
      processed += 1

      const { event, token } = claim
      try {
        await this.process(event)
        const completed = await this.repository.complete(event.eventId, token)
        if (!completed) {
          this.logger.warn({ eventId: event.eventId, eventType: event.eventType }, 'Stripe Connect webhook claim lost before completion')
        }
      } catch (error) {
        const errorClass = errorClassOf(error)
        await this.repository.fail({
          eventId: event.eventId,
          token,
          errorClass,
          terminal: error instanceof ConnectAccountMismatchError
        })
        this.logger.error({ eventId: event.eventId, eventType: event.eventType, errorClass }, 'Stripe Connect webhook event processing failed')
      }
    }

    return processed
  }

  private async process(event: StoredConnectWebhookEvent): Promise<void> {
    if (event.eventType.startsWith('payment_intent.')) {
      await this.processPaymentIntentEvent(event)
    } else if (event.eventType === 'charge.refunded' || event.eventType === 'charge.dispute.created') {
      this.recordRefundOrDispute(event)
    } else if (event.eventType.startsWith('v2.core.account')) {
      await this.processAccountEvent(event)
    } else {
      this.logger.warn({ eventId: event.eventId, eventType: event.eventType }, 'Stripe Connect webhook event type has no handler')
    }
  }

  /**
   * L'événement n'est qu'un déclencheur : le PaymentIntent est relu chez Stripe
   * par le port de réconciliation, jamais déduit du contenu de l'événement.
   */
  private async processPaymentIntentEvent(event: StoredConnectWebhookEvent): Promise<void> {
    const paymentIntentId = event.paymentIntentId ?? event.objectId
    const localAccountId = await this.domain.findPaymentAccountId(paymentIntentId)
    if (localAccountId === null) throw new UnknownConnectPaymentIntentError()

    if (localAccountId !== event.accountId) {
      this.logger.error({
        security: true,
        eventId: event.eventId,
        eventType: event.eventType,
        paymentIntentId,
        eventAccountId: event.accountId,
        localAccountId
      }, 'Stripe Connect webhook account does not match the local payment account: event rejected')
      throw new ConnectAccountMismatchError()
    }

    await this.domain.reconcilePaymentIntent(paymentIntentId)
  }

  /** Politique remboursements/litiges (D7) non tranchée : journalisation structurée, aucune action automatique. */
  private recordRefundOrDispute(event: StoredConnectWebhookEvent): void {
    this.logger.warn({
      eventId: event.eventId,
      eventType: event.eventType,
      accountId: event.accountId,
      objectId: event.objectId,
      paymentIntentId: event.paymentIntentId,
      merchantId: event.merchantId,
      orderId: event.orderId,
      policy: 'D7_undecided_no_automatic_action'
    }, 'Stripe Connect refund or dispute received: no automatic action')
  }

  private async processAccountEvent(event: StoredConnectWebhookEvent): Promise<void> {
    const merchantId = await this.repository.findMerchantIdByAccountId(event.accountId)
    if (merchantId !== null) {
      await this.domain.refreshMerchantAccountStatus(merchantId, event.accountId)
      return
    }
    // Compte de paiement d'un livreur (R30) : même déclencheur, relecture chez Stripe par le domaine.
    const driverId = await this.domain.findDriverIdByAccountId(event.accountId)
    if (driverId === null) throw new UnknownConnectAccountError()

    await this.domain.refreshDriverAccountStatus(driverId, event.accountId)
  }
}
