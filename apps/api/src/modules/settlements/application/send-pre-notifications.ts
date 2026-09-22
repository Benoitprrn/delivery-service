import { announcedDebitDate, buildPreNotificationEmail, preNotificationRetryDelaySeconds } from '../domain/pre-notification.js'
import { addCalendarDays } from '../domain/local-date.js'
import { parisLocalDate } from '../domain/paris-time.js'
import { EmailSendError, PreNotificationNotSendableError } from '../ports/pre-notification.js'
import type { EmailSender, PreNotificationClaim, PreNotificationRecipientReader, PreNotificationRepository } from '../ports/pre-notification.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

export type PreNotificationRunSummary = { enqueued: number; claimed: number; sent: number; failed: number; lostClaims: number }

export type SendPreNotificationsConfig = { creditorId: string; supportEmail: string; batchSize?: number; leaseSeconds?: number; maxAttempts?: number }

/**
 * Envoie la pré-notification SEPA du lundi de chaque règlement restaurant clôturé (R41). Idempotent : une ligne par règlement,
 * un bail par tentative, une clé d'idempotence Resend stable par notification. Un échec est tracé et retenté (backoff) mais
 * ne pose JAMAIS `pre_notified_at` : seule une notification `sent` ouvre la voie au débit (R50).
 */
export class SendPreNotificationsUseCase {
  public constructor(
    private readonly repository: PreNotificationRepository,
    private readonly recipients: PreNotificationRecipientReader,
    private readonly sender: EmailSender,
    private readonly config: SendPreNotificationsConfig,
    private readonly logger: SettlementLogger
  ) {}

  public async execute(input: { now: Date }): Promise<PreNotificationRunSummary> {
    const enqueued = await this.repository.enqueueMissing()
    const claims = await this.repository.claimDue({ limit: this.config.batchSize ?? 20, leaseSeconds: this.config.leaseSeconds ?? 120, maxAttempts: this.config.maxAttempts ?? 30 })
    const summary: PreNotificationRunSummary = { enqueued, claimed: claims.length, sent: 0, failed: 0, lostClaims: 0 }
    for (const claim of claims) {
      const outcome = await this.process(claim, input.now)
      if (outcome === 'sent') summary.sent += 1
      else if (outcome === 'failed') summary.failed += 1
      else summary.lostClaims += 1
    }
    return summary
  }

  private async process(claim: PreNotificationClaim, now: Date): Promise<'sent' | 'failed' | 'lost_claim'> {
    try {
      const recipient = await this.recipients.read(claim.merchantId)
      if (recipient.email === null || recipient.email.trim() === '') throw new PreNotificationNotSendableError('no_recipient_email')
      if (recipient.activeSepaMethod === null) throw new PreNotificationNotSendableError('no_active_sepa_method')
      const { last4, mandateReference } = recipient.activeSepaMethod
      if (last4 === null || mandateReference === null || !/^[0-9A-Za-z]{4}$/.test(last4)) throw new PreNotificationNotSendableError('incomplete_sepa_method')

      // Un seul instant sert au calcul de la date annoncée ET à `sent_at` : la contrainte de préavis (2 jours) de la base ne peut pas dériver.
      const debitDate = announcedDebitDate({ scheduledDebitDate: claim.scheduledDebitDate, sentAt: now })
      const email = buildPreNotificationEmail({
        legalName: recipient.legalName,
        amountCents: claim.amountCents,
        debitDate,
        periodFirstDay: parisLocalDate(claim.periodStart),
        periodLastDay: addCalendarDays(parisLocalDate(claim.periodEnd), -1),
        ibanLast4: last4,
        mandateReference,
        creditorId: this.config.creditorId,
        supportEmail: this.config.supportEmail
      })
      // Clé stable par notification : un retry ou une reprise de bail dans les 24 h ne produit pas un second e-mail chez Resend.
      const sent = await this.sender.send({ idempotencyKey: `settlement-pre-notification-${claim.id}`, to: recipient.email, ...email })
      const marked = await this.repository.markSent({
        id: claim.id,
        claimToken: claim.claimToken,
        sentAt: now,
        snapshot: { recipientEmail: recipient.email, debitDate, ibanLast4: last4, mandateReference, creditorId: this.config.creditorId, provider: sent.provider, providerMessageId: sent.messageId }
      })
      if (marked === 'lost_claim') {
        this.logger.warn({ preNotificationId: claim.id }, 'Pre-notification sent but the claim was lost; another worker owns it')
        return 'lost_claim'
      }
      this.logger.info({ preNotificationId: claim.id, merchantSettlementId: claim.merchantSettlementId, amountCents: claim.amountCents, debitDate }, 'Settlement pre-notification sent')
      return 'sent'
    } catch (error) {
      const errorClass = error instanceof PreNotificationNotSendableError ? error.reason : error instanceof EmailSendError ? `email_${error.kind}` : error instanceof Error ? error.constructor.name : 'UnknownError'
      try {
        await this.repository.markFailed({ id: claim.id, claimToken: claim.claimToken, errorClass, retryAfterSeconds: preNotificationRetryDelaySeconds(claim.attemptCount) })
      } catch {
        this.logger.error({ preNotificationId: claim.id }, 'Pre-notification failure could not be recorded; the lease will expire')
      }
      this.logger.warn({ preNotificationId: claim.id, merchantSettlementId: claim.merchantSettlementId, attempt: claim.attemptCount, errorClass }, 'Settlement pre-notification failed; it will be retried')
      return 'failed'
    }
  }
}
