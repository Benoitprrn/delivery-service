import type { Pool } from 'pg'
import { parseLocalDate } from '../domain/local-date.js'
import type { PreNotificationClaim, PreNotificationRepository, PreNotificationSentSnapshot } from '../ports/pre-notification.js'

type ClaimRow = { id: string; merchant_settlement_id: string; merchant_id: string; amount_cents: string; debit_date: string; period_start: Date; period_end: Date; attempt_count: number; claim_token: string }

/**
 * File durable des pré-notifications du lundi (R41). Chaque changement d'état est un UPDATE atomique conditionné par le jeton de
 * bail : un worker expiré ne peut ni marquer « envoyé » ni « échoué » le travail d'un autre. Aucun appel réseau dans une transaction.
 */
export class PostgresPreNotificationRepository implements PreNotificationRepository {
  public constructor(private readonly pool: Pool) {}

  public async enqueueMissing(): Promise<number> {
    const result = await this.pool.query(
      `insert into settlement_pre_notifications(merchant_settlement_id, amount_cents, attempt_no)
       select ms.id, ms.amount_cents, 1
         from merchant_settlements ms join settlement_periods p on p.id = ms.period_id
        where p.status = 'closed' and ms.status = 'pending_notification' and ms.pre_notified_at is null and ms.amount_cents > 0
       on conflict (merchant_settlement_id, attempt_no) do nothing`
    )
    return result.rowCount ?? 0
  }

  public async claimDue(input: { limit: number; leaseSeconds: number; maxAttempts: number }): Promise<PreNotificationClaim[]> {
    const result = await this.pool.query<ClaimRow>(
      `with due as (
         select id from settlement_pre_notifications
          where attempt_count < $3
            and ((status in ('pending','failed') and next_attempt_at <= now()) or (status = 'sending' and lease_expires_at < now()))
          order by next_attempt_at, created_at
          limit $1
          for update skip locked
       ), claimed as (
         update settlement_pre_notifications n
            set status = 'sending', claim_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => $2),
                attempt_count = n.attempt_count + 1, updated_at = now()
           from due where n.id = due.id
         returning n.id, n.merchant_settlement_id, n.amount_cents, n.attempt_count, n.claim_token
       )
       select c.id, c.merchant_settlement_id, ms.merchant_id, c.amount_cents::text as amount_cents, p.debit_date::text as debit_date,
              p.period_start, p.period_end, c.attempt_count, c.claim_token
         from claimed c join merchant_settlements ms on ms.id = c.merchant_settlement_id join settlement_periods p on p.id = ms.period_id
        order by c.id`,
      [input.limit, input.leaseSeconds, input.maxAttempts]
    )
    return result.rows.map((row) => ({
      id: row.id,
      merchantSettlementId: row.merchant_settlement_id,
      merchantId: row.merchant_id,
      amountCents: Number(row.amount_cents),
      scheduledDebitDate: parseLocalDate(row.debit_date),
      periodStart: row.period_start,
      periodEnd: row.period_end,
      attemptCount: row.attempt_count,
      claimToken: row.claim_token
    }))
  }

  public async markSent(input: { id: string; claimToken: string; sentAt: Date; snapshot: PreNotificationSentSnapshot }): Promise<'sent' | 'lost_claim'> {
    const { snapshot } = input
    const result = await this.pool.query(
      `update settlement_pre_notifications
          set status = 'sent', sent_at = $10::timestamptz, claim_token = null, lease_expires_at = null, last_error_class = null,
              recipient_email = $3, debit_date = $4::date, iban_last4 = $5, mandate_reference = $6, creditor_id = $7,
              provider = $8, provider_message_id = $9, updated_at = now()
        where id = $1 and claim_token = $2 and status = 'sending'`,
      [input.id, input.claimToken, snapshot.recipientEmail, snapshot.debitDate, snapshot.ibanLast4, snapshot.mandateReference, snapshot.creditorId, snapshot.provider, snapshot.providerMessageId, input.sentAt]
    )
    return result.rowCount === 1 ? 'sent' : 'lost_claim'
  }

  public async markFailed(input: { id: string; claimToken: string; errorClass: string; retryAfterSeconds: number }): Promise<boolean> {
    const result = await this.pool.query(
      `update settlement_pre_notifications
          set status = 'failed', claim_token = null, lease_expires_at = null, last_error_class = $3, last_failed_at = now(),
              next_attempt_at = now() + make_interval(secs => $4), updated_at = now()
        where id = $1 and claim_token = $2 and status = 'sending'`,
      [input.id, input.claimToken, input.errorClass, input.retryAfterSeconds]
    )
    return result.rowCount === 1
  }
}
