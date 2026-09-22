/**
 * Ports du webhook Stripe Connect (Direct Charge du paiement carte à la livraison).
 *
 * Les événements Connect arrivent sur un endpoint distinct de celui du SEPA,
 * avec leur propre secret de signature. Le payload n'est jamais conservé : le
 * journal ne garde que l'identifiant, le type, le compte connecté et quelques
 * identifiants métier minimaux. L'événement n'est qu'un déclencheur ; la source
 * de vérité est toujours une relecture chez Stripe.
 */

/** Événements « snapshot » (v1) acceptés ; chacun porte `event.account`. */
export const CONNECT_SNAPSHOT_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.amount_capturable_updated',
  'charge.refunded',
  'charge.dispute.created'
] as const

/** Événements minces (v2) sur l'état du compte : configuration `merchant` (restaurant) et `recipient` (livreur, R30). */
export const CONNECT_THIN_EVENT_TYPES = [
  'v2.core.account[configuration.merchant].capability_status_updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.recipient].capability_status_updated',
  'v2.core.account[configuration.recipient].updated',
  'v2.core.account[requirements].updated',
  'v2.core.account.closed'
] as const

export const CONNECT_SUPPORTED_EVENT_TYPES: readonly string[] = [
  ...CONNECT_SNAPSHOT_EVENT_TYPES,
  ...CONNECT_THIN_EVENT_TYPES
]

/** Un événement Stripe vérifié, réduit aux seuls champs que le module lit. */
export type VerifiedConnectEvent =
  | {
    style: 'snapshot'
    id: string
    type: string
    accountId: string | null
    object: {
      id: string | null
      paymentIntentId: string | null
      metadata: { merchantId: string | null; orderId: string | null }
    }
  }
  | {
    style: 'thin'
    id: string
    type: string
    /** Compte Stripe porté par `related_object` de la notification mince. */
    accountId: string | null
  }

export interface ConnectWebhookVerifier {
  /**
   * Vérifie toujours la signature sur le corps brut. Lève
   * `ConnectWebhookSignatureError` si aucune signature ne correspond et
   * `StripeUnavailableError` si l'endpoint n'est pas configuré.
   */
  verify(payload: string | Buffer, signature: string): VerifiedConnectEvent
}

/** Ce que le journal conserve d'un événement : jamais le payload. */
export type StoredConnectWebhookEvent = {
  eventId: string
  eventType: string
  accountId: string
  objectId: string
  paymentIntentId: string | null
  merchantId: string | null
  orderId: string | null
}

export type ClaimedConnectWebhookEvent = { event: StoredConnectWebhookEvent; token: string }

export type ConnectWebhookFailure = {
  eventId: string
  token: string
  errorClass: string
  /** Échec définitif (ex. compte incohérent) : `dead_letter` sans nouvelle tentative. */
  terminal: boolean
}

export interface ConnectWebhookRepository {
  /** Insère l'événement `pending` ; un doublon (même `event_id`) est ignoré. */
  record(event: StoredConnectWebhookEvent): Promise<void>
  claimNext(): Promise<ClaimedConnectWebhookEvent | null>
  complete(eventId: string, token: string): Promise<boolean>
  fail(failure: ConnectWebhookFailure): Promise<boolean>
  /** Marchand local dont le profil de paiement porte ce compte Stripe, sinon `null`. */
  findMerchantIdByAccountId(accountId: string): Promise<string | null>
}

/**
 * Couture vers le domaine cash-on-delivery. Le module payments n'importe pas
 * cash-on-delivery : l'assemblage (`app.ts`) fournit ces trois capacités.
 */
export interface ConnectWebhookDomainPorts {
  /** `stripe_account_id` du paiement COD local portant ce PaymentIntent, sinon `null`. */
  findPaymentAccountId(paymentIntentId: string): Promise<string | null>
  /**
   * Relit le PaymentIntent chez Stripe et applique la transition locale
   * correspondante. Le webhook ne finalise JAMAIS une commande lui-même.
   */
  reconcilePaymentIntent(paymentIntentId: string): Promise<unknown>
  /** Relit le compte chez Stripe (getAccountStatus) et met à jour `merchant_stripe_connect`. */
  refreshMerchantAccountStatus(merchantId: string, accountId: string): Promise<void>
  /** Relit le compte livreur chez Stripe et met à jour `driver_connect_accounts` (jamais depuis le contenu de l'événement). */
  refreshDriverAccountStatus(driverId: string, accountId: string): Promise<void>
  /** Livreur local dont le compte de paiement Connect porte ce compte Stripe, sinon `null` (table du module settlements). */
  findDriverIdByAccountId(accountId: string): Promise<string | null>
}

export class ConnectWebhookSignatureError extends Error {}
export class ConnectReconcilerNotWiredError extends Error {}
