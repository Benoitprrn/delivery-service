import type { LocalDate } from '../domain/local-date.js'

export type PreNotificationClaim = {
  id: string
  merchantSettlementId: string
  merchantId: string
  amountCents: number
  scheduledDebitDate: LocalDate
  periodStart: Date
  periodEnd: Date
  attemptCount: number
  claimToken: string
}

export type PreNotificationSentSnapshot = {
  recipientEmail: string
  debitDate: LocalDate
  ibanLast4: string
  mandateReference: string
  creditorId: string
  provider: string
  providerMessageId: string
}

export interface PreNotificationRepository {
  /** Crée (idempotent) la notification `pending` de chaque règlement clôturé, non nul, non encore notifié. Renvoie le nombre créé. */
  enqueueMissing(): Promise<number>
  /** Réserve (bail) les notifications dues ; un bail expiré est repris ; jamais plus de `maxAttempts` tentatives. */
  claimDue(input: { limit: number; leaseSeconds: number; maxAttempts: number }): Promise<PreNotificationClaim[]>
  /** `sent` à `sentAt` (l'instant même utilisé pour calculer la date annoncée) + miroir `pre_notified_at`, dans UNE transaction, seulement si le bail est encore le nôtre. */
  markSent(input: { id: string; claimToken: string; sentAt: Date; snapshot: PreNotificationSentSnapshot }): Promise<'sent' | 'lost_claim'>
  markFailed(input: { id: string; claimToken: string; errorClass: string; retryAfterSeconds: number }): Promise<boolean>
}

export type PreNotificationRecipient = {
  email: string | null
  legalName: string
  activeSepaMethod: { last4: string | null; mandateReference: string | null } | null
}

/** Lecture des données du destinataire dans les autres modules (auth, payments, merchants) : injectée par `app.ts`. */
export interface PreNotificationRecipientReader {
  read(merchantId: string): Promise<PreNotificationRecipient>
}

export type OutgoingEmail = { idempotencyKey: string; to: string; subject: string; text: string; html: string }

export interface EmailSender {
  send(email: OutgoingEmail): Promise<{ provider: string; messageId: string }>
}

/** Échec d'envoi côté fournisseur : tracé, retenté ; jamais compté comme envoyé. */
export class EmailSendError extends Error {
  public constructor(message: string, public readonly kind: 'transient' | 'rejected') { super(message); this.name = 'EmailSendError' }
}

/** Données requises absentes (e-mail, mandat actif, identifiant créancier…) : rien n'est envoyé, l'état reste retentable. */
export class PreNotificationNotSendableError extends Error {
  public constructor(public readonly reason: 'no_recipient_email' | 'no_active_sepa_method' | 'incomplete_sepa_method') { super(`Pre-notification not sendable: ${reason}`); this.name = 'PreNotificationNotSendableError' }
}
