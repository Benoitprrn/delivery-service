import type { Pool } from 'pg'
import type { RetryAttemptSummary } from '../domain/debit-retry.js'
import type { DebitRetryRepository } from '../ports/settlement-ops.js'

export class PostgresDebitRetryRepository implements DebitRetryRepository {
  public constructor(private readonly pool: Pool) {}

  public async loadContext(merchantSettlementId: string): Promise<{ amountCents: number; attempts: RetryAttemptSummary[]; hasOpenRetryRequest: boolean } | null> {
    const settlement = await this.pool.query<{ amount: string }>('select amount_cents::text as amount from merchant_settlements where id = $1::uuid', [merchantSettlementId])
    if (settlement.rows[0] === undefined) return null
    const attempts = await this.pool.query<{ attempt_no: number; status: RetryAttemptSummary['status'] }>('select attempt_no, status from debit_attempts where merchant_settlement_id = $1::uuid order by attempt_no', [merchantSettlementId])
    const open = await this.pool.query<{ open: boolean }>(
      `select exists (select 1 from settlement_pre_notifications n where n.merchant_settlement_id = $1::uuid
                       and n.attempt_no > coalesce((select max(a.attempt_no) from debit_attempts a where a.merchant_settlement_id = n.merchant_settlement_id), 0)) as open`,
      [merchantSettlementId]
    )
    return { amountCents: Number(settlement.rows[0].amount), attempts: attempts.rows.map((row) => ({ attemptNo: row.attempt_no, status: row.status })), hasOpenRetryRequest: open.rows[0]?.open === true }
  }

  public async createRetryNotification(input: { merchantSettlementId: string; attemptNo: number; amountCents: number; requestedBy: string; reason: string }): Promise<{ outcome: 'created'; preNotificationId: string } | { outcome: 'exists' }> {
    const result = await this.pool.query<{ id: string }>(
      `insert into settlement_pre_notifications(merchant_settlement_id, amount_cents, attempt_no, requested_by, retry_reason)
       values($1::uuid, $2::bigint, $3::int, $4::uuid, $5) on conflict (merchant_settlement_id, attempt_no) do nothing returning id`,
      [input.merchantSettlementId, input.amountCents, input.attemptNo, input.requestedBy, input.reason]
    )
    return result.rows[0] === undefined ? { outcome: 'exists' } : { outcome: 'created', preNotificationId: result.rows[0].id }
  }
}
