import Stripe from 'stripe'
import { StripeUnavailableError } from '../ports/stripe-provider.js'
import {
  ConnectWebhookSignatureError,
  type ConnectWebhookVerifier,
  type VerifiedConnectEvent
} from '../ports/connect-webhook.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function optionalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Le corps n'est examiné avant vérification que pour choisir le point d'entrée
 * du SDK (événement mince v2 ou snapshot v1). Les deux vérifient la signature
 * sur le corps brut : rien n'est cru avant cette vérification.
 */
function looksLikeThinEvent(payload: string | Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as { object?: unknown }).object === 'v2.core.event'
  } catch {
    return false
  }
}

export class StripeConnectWebhookVerifier implements ConnectWebhookVerifier {
  /**
   * `stripe` n'effectue aucun appel réseau ici (parsing et signature locaux).
   * `secrets` : un secret par destination d'événements Stripe (une destination
   * « snapshot » pour les comptes connectés, une destination « mince » pour
   * les événements Accounts v2), les deux pointant vers le même endpoint.
   */
  constructor(private readonly stripe: Stripe, private readonly secrets: readonly string[]) {}

  verify(payload: string | Buffer, signature: string): VerifiedConnectEvent {
    const thin = looksLikeThinEvent(payload)

    for (const secret of this.secrets) {
      try {
        return thin
          ? this.mapThinEvent(payload, signature, secret)
          : this.mapSnapshotEvent(payload, signature, secret)
      } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError) continue
        throw error
      }
    }

    throw new ConnectWebhookSignatureError('Invalid Stripe Connect webhook signature')
  }

  private mapSnapshotEvent(payload: string | Buffer, signature: string, secret: string): VerifiedConnectEvent {
    const event = this.stripe.webhooks.constructEvent(payload, signature, secret)
    const object = event.data.object as unknown as {
      id?: unknown
      payment_intent?: unknown
      metadata?: { merchant_id?: unknown; order_id?: unknown } | null
    }
    const isPaymentIntent = event.type.startsWith('payment_intent.')

    return {
      style: 'snapshot',
      id: event.id,
      type: event.type,
      accountId: optionalString(event.account),
      object: {
        id: optionalString(object.id),
        paymentIntentId: isPaymentIntent ? optionalString(object.id) : optionalString(object.payment_intent),
        metadata: {
          merchantId: optionalUuid(object.metadata?.merchant_id),
          orderId: optionalUuid(object.metadata?.order_id)
        }
      }
    }
  }

  private mapThinEvent(payload: string | Buffer, signature: string, secret: string): VerifiedConnectEvent {
    const notification = this.stripe.parseEventNotification(payload, signature, secret)
    const related = 'related_object' in notification ? notification.related_object : null

    return {
      style: 'thin',
      id: notification.id,
      type: notification.type,
      accountId: optionalString(related?.id)
    }
  }
}

/** Route désactivée (Stripe coupé ou secret Connect absent) : 503, jamais une signature « invalide ». */
export class UnavailableConnectWebhookVerifier implements ConnectWebhookVerifier {
  verify(): VerifiedConnectEvent {
    throw new StripeUnavailableError('Stripe Connect webhook is not configured')
  }
}
