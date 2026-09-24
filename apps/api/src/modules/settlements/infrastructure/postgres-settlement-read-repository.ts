import type { Pool } from 'pg'
import type {
  AdminOverviewRows, DebitAttemptStatus, DriverPeriodRow, DriverStatementRow, MerchantSettlementLineRow, MerchantSettlementRow, SettlementReadRepository
} from '../ports/settlement-read.js'
import type { StatementStatus } from '../domain/statement-status.js'

const num = (value: string | number | null): number => Number(value ?? 0)
const iso = (value: Date | null): Date | null => value

/**
 * Lecture du règlement (R80) : requêtes SQL UNIQUEMENT (aucune écriture). Ne renvoie aucune identité : les noms viennent de `SettlementDirectory`.
 * Le restaurant ne voit jamais un gain livreur, des frais Locadely ni un livreur : ses requêtes ne lisent que `merchant_amount_cents`.
 */
export class PostgresSettlementReadRepository implements SettlementReadRepository {
  public constructor(private readonly pool: Pool) {}

  public async listDriverPeriods(driverId: string, limit: number): Promise<DriverPeriodRow[]> {
    const periods = await this.pool.query<{ id: string; period_start: Date; period_end: Date; closed_at: Date | null; payrun_at: Date | null; promise_deadline: string | null }>(
      `select sp.id, sp.period_start, sp.period_end, sp.closed_at, sp.payrun_at, sp.promise_deadline::text as promise_deadline
         from settlement_periods sp
        where sp.status = 'closed' and exists (select 1 from settlement_statements st where st.period_id = sp.id and st.driver_id = $1::uuid)
        order by sp.period_start desc limit $2`,
      [driverId, limit]
    )
    if (periods.rows.length === 0) return []
    const statements = await this.pool.query<{ id: string; period_id: string; merchant_id: string; due: string; paid: string; status: StatementStatus; hold: string | null; settlement_status: string; attempt_no: number | null; debit_status: DebitAttemptStatus | null; incident: boolean }>(
      `select st.id, st.period_id, st.merchant_id, st.due_cents::text as due, st.paid_cents::text as paid, st.status, st.payout_hold_reason as hold, ms.status as settlement_status,
              d.attempt_no, d.status as debit_status,
              coalesce(exists (select 1 from debit_incidents i where i.debit_attempt_id = d.id and i.status in ('open','lost')), false) as incident
         from settlement_statements st
         join merchant_settlements ms on ms.id = st.merchant_settlement_id
         left join lateral (select a.id, a.attempt_no, a.status from debit_attempts a where a.merchant_settlement_id = st.merchant_settlement_id order by (a.status = 'succeeded') desc, a.attempt_no desc limit 1) d on true
        where st.driver_id = $1::uuid and st.period_id = any($2::uuid[])
        order by st.created_at, st.id`,
      [driverId, periods.rows.map((p) => p.id)]
    )
    const byPeriod = new Map<string, DriverStatementRow[]>()
    for (const row of statements.rows) {
      const list = byPeriod.get(row.period_id) ?? []
      list.push({
        statementId: row.id, merchantId: row.merchant_id, dueCents: num(row.due), paidCents: num(row.paid), status: row.status, holdReason: row.hold, settlementStatus: row.settlement_status,
        debit: row.attempt_no === null || row.debit_status === null ? null : { attemptNo: row.attempt_no, status: row.debit_status }, incidentOpen: row.incident
      })
      byPeriod.set(row.period_id, list)
    }
    return periods.rows.map((p) => ({ periodId: p.id, periodStart: p.period_start, periodEnd: p.period_end, closedAt: p.closed_at, payrunAt: p.payrun_at, promiseDeadline: p.promise_deadline, statements: byPeriod.get(p.id) ?? [] }))
  }

  public async listMerchantSettlements(merchantId: string, limit: number): Promise<MerchantSettlementRow[]> {
    const base = await this.pool.query<{ id: string; period_start: Date; period_end: Date; amount: string; delivery: string; service_fee: string; status: string; deliveries: string }>(
      `select ms.id, sp.period_start, sp.period_end, ms.amount_cents::text as amount, ms.driver_amount_cents::text as delivery, ms.service_fee_cents::text as service_fee, ms.status,
              (select count(*) from settlement_lines l join settlement_statements s on s.id = l.statement_id where s.merchant_settlement_id = ms.id)::text as deliveries
         from merchant_settlements ms join settlement_periods sp on sp.id = ms.period_id
        where ms.merchant_id = $1::uuid order by sp.period_start desc limit $2`,
      [merchantId, limit]
    )
    return this.enrichMerchantRows(base.rows.map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, amount: num(r.amount), deliveryCents: num(r.delivery), serviceFeeCents: num(r.service_fee), status: r.status, deliveries: num(r.deliveries) })))
  }

  public async getMerchantSettlement(merchantId: string, merchantSettlementId: string): Promise<{ row: MerchantSettlementRow; lines: MerchantSettlementLineRow[] } | null> {
    const base = await this.pool.query<{ id: string; period_start: Date; period_end: Date; amount: string; delivery: string; service_fee: string; status: string; deliveries: string }>(
      `select ms.id, sp.period_start, sp.period_end, ms.amount_cents::text as amount, ms.driver_amount_cents::text as delivery, ms.service_fee_cents::text as service_fee, ms.status,
              (select count(*) from settlement_lines l join settlement_statements s on s.id = l.statement_id where s.merchant_settlement_id = ms.id)::text as deliveries
         from merchant_settlements ms join settlement_periods sp on sp.id = ms.period_id
        where ms.merchant_id = $1::uuid and ms.id = $2::uuid`,
      [merchantId, merchantSettlementId]
    )
    const first = base.rows[0]
    if (first === undefined) return null
    const [row] = await this.enrichMerchantRows([{ id: first.id, periodStart: first.period_start, periodEnd: first.period_end, amount: num(first.amount), deliveryCents: num(first.delivery), serviceFeeCents: num(first.service_fee), status: first.status, deliveries: num(first.deliveries) }])
    const lines = await this.pool.query<{ order_id: string; finalized_at: Date; final_status: 'COMPLETED' | 'RETURNED'; merchant_amount_cents: string; delivery_cents: string; service_fee_cents: string }>(
      `select l.order_id, l.finalized_at, l.final_status, l.merchant_amount_cents::text as merchant_amount_cents, l.delivery_cents::text as delivery_cents, l.service_fee_cents::text as service_fee_cents
         from settlement_lines l join settlement_statements s on s.id = l.statement_id where s.merchant_settlement_id = $1::uuid order by l.finalized_at, l.order_id`,
      [merchantSettlementId]
    )
    return { row: row!, lines: lines.rows.map((l) => ({ orderId: l.order_id, finalizedAt: l.finalized_at, finalStatus: l.final_status, merchantAmountCents: num(l.merchant_amount_cents), deliveryCents: num(l.delivery_cents), serviceFeeCents: num(l.service_fee_cents) })) }
  }

  private async enrichMerchantRows(base: Array<{ id: string; periodStart: Date; periodEnd: Date; amount: number; deliveryCents: number; serviceFeeCents: number; status: string; deliveries: number }>): Promise<MerchantSettlementRow[]> {
    if (base.length === 0) return []
    const ids = base.map((b) => b.id)
    const [notifications, attempts, incidents, receivables, retries] = await Promise.all([
      this.pool.query<{ merchant_settlement_id: string; attempt_no: number; status: 'pending' | 'sending' | 'sent' | 'failed'; sent_at: Date | null; debit_date: string | null; iban_last4: string | null; mandate_reference: string | null }>(
        `select distinct on (merchant_settlement_id) merchant_settlement_id, attempt_no, status, sent_at, debit_date::text as debit_date, iban_last4, mandate_reference
           from settlement_pre_notifications where merchant_settlement_id = any($1::uuid[]) order by merchant_settlement_id, attempt_no desc`, [ids]),
      this.pool.query<{ merchant_settlement_id: string; attempt_no: number; status: DebitAttemptStatus; created_at: Date; updated_at: Date }>(
        'select merchant_settlement_id, attempt_no, status, created_at, updated_at from debit_attempts where merchant_settlement_id = any($1::uuid[]) order by merchant_settlement_id, attempt_no', [ids]),
      this.pool.query<{ merchant_settlement_id: string; kind: 'dispute' | 'refund'; amount: string; status: 'open' | 'won' | 'lost' | 'closed' }>(
        `select a.merchant_settlement_id, i.kind, i.amount_cents::text as amount, i.status from debit_incidents i join debit_attempts a on a.id = i.debit_attempt_id where a.merchant_settlement_id = any($1::uuid[]) order by i.detected_at`, [ids]),
      this.pool.query<{ merchant_settlement_id: string; open: string }>(
        "select merchant_settlement_id, coalesce(sum(amount_cents), 0)::text as open from merchant_receivables where status = 'open' and merchant_settlement_id = any($1::uuid[]) group by merchant_settlement_id", [ids]),
      this.pool.query<{ merchant_settlement_id: string }>(
        `select n.merchant_settlement_id from settlement_pre_notifications n
          where n.merchant_settlement_id = any($1::uuid[]) and n.attempt_no > coalesce((select max(a.attempt_no) from debit_attempts a where a.merchant_settlement_id = n.merchant_settlement_id), 0) and n.attempt_no > 1`, [ids])
    ])
    return base.map((b) => {
      const n = notifications.rows.find((r) => r.merchant_settlement_id === b.id)
      return {
        merchantSettlementId: b.id, periodStart: b.periodStart, periodEnd: b.periodEnd, amountCents: b.amount, deliveryCents: b.deliveryCents, serviceFeeCents: b.serviceFeeCents, deliveriesCount: b.deliveries, status: b.status,
        preNotification: n === undefined ? null : { attemptNo: n.attempt_no, status: n.status, sentAt: n.sent_at, debitDate: n.debit_date, ibanLast4: n.iban_last4, mandateReference: n.mandate_reference },
        attempts: attempts.rows.filter((r) => r.merchant_settlement_id === b.id).map((r) => ({ attemptNo: r.attempt_no, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at })),
        incidents: incidents.rows.filter((r) => r.merchant_settlement_id === b.id).map((r) => ({ kind: r.kind, amountCents: num(r.amount), status: r.status })),
        openReceivablesCents: num(receivables.rows.find((r) => r.merchant_settlement_id === b.id)?.open ?? 0),
        retryRequested: retries.rows.some((r) => r.merchant_settlement_id === b.id)
      }
    })
  }

  public async adminOverview(limit: number): Promise<AdminOverviewRows> {
    const settlementsBase = await this.pool.query<{ id: string; period_start: Date; period_end: Date; merchant_id: string; amount: string; status: string; blocked: string | null; statements: string; paid_statements: string }>(
      `select ms.id, sp.period_start, sp.period_end, ms.merchant_id, ms.amount_cents::text as amount, ms.status, ms.debit_blocked_reason as blocked,
              (select count(*) from settlement_statements s where s.merchant_settlement_id = ms.id)::text as statements,
              (select count(*) from settlement_statements s where s.merchant_settlement_id = ms.id and s.paid_cents >= s.due_cents)::text as paid_statements
         from merchant_settlements ms join settlement_periods sp on sp.id = ms.period_id
        order by sp.period_start desc, ms.created_at desc limit $1`, [limit])
    const ids = settlementsBase.rows.map((r) => r.id)
    const [attempts, notifications, retries] = await Promise.all([
      this.pool.query<{ merchant_settlement_id: string; attempt_no: number; status: DebitAttemptStatus; failure_code: string | null }>('select merchant_settlement_id, attempt_no, status, failure_code from debit_attempts where merchant_settlement_id = any($1::uuid[]) order by merchant_settlement_id, attempt_no', [ids]),
      this.pool.query<{ merchant_settlement_id: string; attempt_no: number; status: string; sent_at: Date | null; debit_date: string | null; last_error_class: string | null }>(
        `select distinct on (merchant_settlement_id) merchant_settlement_id, attempt_no, status, sent_at, debit_date::text as debit_date, last_error_class
           from settlement_pre_notifications where merchant_settlement_id = any($1::uuid[]) order by merchant_settlement_id, attempt_no desc`, [ids]),
      this.pool.query<{ merchant_settlement_id: string }>(
        `select n.merchant_settlement_id from settlement_pre_notifications n where n.merchant_settlement_id = any($1::uuid[])
            and n.attempt_no > coalesce((select max(a.attempt_no) from debit_attempts a where a.merchant_settlement_id = n.merchant_settlement_id), 0) and n.attempt_no > 1`, [ids])
    ])
    const settlements = settlementsBase.rows.map((r) => {
      const n = notifications.rows.find((x) => x.merchant_settlement_id === r.id)
      return {
        merchantSettlementId: r.id, periodStart: r.period_start, periodEnd: r.period_end, merchantId: r.merchant_id, amountCents: num(r.amount), status: r.status, debitBlockedReason: r.blocked,
        attempts: attempts.rows.filter((a) => a.merchant_settlement_id === r.id).map((a) => ({ attemptNo: a.attempt_no, status: a.status, failureCode: a.failure_code })),
        notification: n === undefined ? null : { attemptNo: n.attempt_no, status: n.status, sentAt: iso(n.sent_at), debitDate: n.debit_date, lastErrorClass: n.last_error_class },
        statementsCount: num(r.statements), statementsPaidCount: num(r.paid_statements), hasOpenRetryRequest: retries.rows.some((x) => x.merchant_settlement_id === r.id)
      }
    })
    const [incidents, merchantReceivables, driverReceivables, findings, transfers, reversals, blocked, deadLetters] = await Promise.all([
      this.pool.query<{ id: string; merchant_id: string; kind: 'dispute' | 'refund'; amount: string; status: string; reason: string | null; detected_at: Date; receivable_status: string | null }>(
        `select i.id, ms.merchant_id, i.kind, i.amount_cents::text as amount, i.status, i.reason, i.detected_at, (select r.status from merchant_receivables r where r.debit_incident_id = i.id) as receivable_status
           from debit_incidents i join debit_attempts a on a.id = i.debit_attempt_id join merchant_settlements ms on ms.id = a.merchant_settlement_id order by i.detected_at desc limit $1`, [limit]),
      this.pool.query<{ id: string; merchant_id: string; kind: string; amount: string; status: string; created_at: Date }>('select id, merchant_id, kind, amount_cents::text as amount, status, created_at from merchant_receivables order by (status = \'open\') desc, created_at desc limit $1', [limit]),
      this.pool.query<{ id: string; driver_id: string; amount: string; status: string; created_at: Date }>('select id, driver_id, amount_cents::text as amount, status, created_at from driver_receivables order by (status = \'open\') desc, created_at desc limit $1', [limit]),
      this.pool.query<{ id: string; kind: string; scope: 'restaurant' | 'locadely_technical'; ref_type: string; ref_id: string; expected: string | null; actual: string | null; created_at: Date; last_seen_at: Date }>(
        'select id, kind, scope, ref_type, ref_id, expected_cents::text as expected, actual_cents::text as actual, created_at, last_seen_at from settlement_reconciliation_findings where resolved_at is null order by last_seen_at desc limit $1', [limit]),
      this.pool.query<{ id: string; statement_id: string; driver_id: string; merchant_id: string; amount: string; status: string; succeeded_at: Date | null; reversed: string }>(
        `select t.id, t.statement_id, st.driver_id, st.merchant_id, t.amount_cents::text as amount, t.status, t.succeeded_at,
                (select coalesce(sum(r.reversed_cents), 0) from driver_transfer_reversals r where r.driver_transfer_id = t.id and r.status = 'succeeded')::text as reversed
           from driver_transfers t join settlement_statements st on st.id = t.statement_id where t.status = 'succeeded' order by t.succeeded_at desc nulls last limit $1`, [limit]),
      this.pool.query<{ id: string; driver_transfer_id: string; driver_id: string; status: string; category: string; reason_code: string; reason: string; decision_reference: string; amount: string; requested_by: string; approved_by: string | null; planned_reverse: string | null; planned_receivable: string | null; reversed: string | null; failure_code: string | null; created_at: Date }>(
        `select id, driver_transfer_id, driver_id, status, category, reason_code, reason, decision_reference, amount_cents::text as amount, requested_by, approved_by,
                planned_reverse_cents::text as planned_reverse, planned_receivable_cents::text as planned_receivable, reversed_cents::text as reversed, failure_code, created_at
           from driver_transfer_reversals order by created_at desc limit $1`, [limit]),
      this.pool.query<{ id: string; driver_id: string; merchant_id: string; due: string; paid: string; status: string; hold: string | null; next_attempt_at: Date | null }>(
        `select id, driver_id, merchant_id, due_cents::text as due, paid_cents::text as paid, status, payout_hold_reason as hold, payout_next_attempt_at as next_attempt_at
           from settlement_statements where paid_cents < due_cents and (payout_hold_reason is not null or status = 'blocked_driver_account') order by updated_at desc limit $1`, [limit]),
      this.pool.query<{ event_id: string; event_type: string; attempt_count: number; last_error_class: string | null; received_at: Date }>(
        "select event_id, event_type, attempt_count, last_error_class, received_at from settlement_stripe_events where status = 'dead_letter' order by received_at desc limit $1", [limit])
    ])
    return {
      settlements,
      incidents: incidents.rows.map((r) => ({ id: r.id, merchantId: r.merchant_id, kind: r.kind, amountCents: num(r.amount), status: r.status, reason: r.reason, detectedAt: r.detected_at, receivableStatus: r.receivable_status })),
      receivables: [
        ...merchantReceivables.rows.map((r) => ({ scope: 'merchant' as const, id: r.id, ownerId: r.merchant_id, kind: r.kind, amountCents: num(r.amount), status: r.status, createdAt: r.created_at })),
        ...driverReceivables.rows.map((r) => ({ scope: 'driver' as const, id: r.id, ownerId: r.driver_id, kind: 'driver_reversal_shortfall', amountCents: num(r.amount), status: r.status, createdAt: r.created_at }))
      ],
      findings: findings.rows.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, refType: r.ref_type, refId: r.ref_id, expectedCents: r.expected === null ? null : num(r.expected), actualCents: r.actual === null ? null : num(r.actual), firstSeenAt: r.created_at, lastSeenAt: r.last_seen_at })),
      transfers: transfers.rows.map((r) => ({ driverTransferId: r.id, statementId: r.statement_id, driverId: r.driver_id, merchantId: r.merchant_id, amountCents: num(r.amount), status: r.status, succeededAt: r.succeeded_at, reversedCents: num(r.reversed) })),
      reversals: reversals.rows.map((r) => ({
        id: r.id, driverTransferId: r.driver_transfer_id, driverId: r.driver_id, status: r.status, category: r.category, reasonCode: r.reason_code, reason: r.reason, decisionReference: r.decision_reference, amountCents: num(r.amount),
        requestedBy: r.requested_by, approvedBy: r.approved_by, plannedReverseCents: r.planned_reverse === null ? null : num(r.planned_reverse), plannedReceivableCents: r.planned_receivable === null ? null : num(r.planned_receivable),
        reversedCents: r.reversed === null ? null : num(r.reversed), failureCode: r.failure_code, createdAt: r.created_at
      })),
      blockedStatements: blocked.rows.map((r) => ({ statementId: r.id, driverId: r.driver_id, merchantId: r.merchant_id, dueCents: num(r.due), paidCents: num(r.paid), status: r.status, holdReason: r.hold, nextAttemptAt: r.next_attempt_at })),
      deadLetters: deadLetters.rows.map((r) => ({ eventId: r.event_id, eventType: r.event_type, attemptCount: r.attempt_count, lastErrorClass: r.last_error_class, receivedAt: r.received_at }))
    }
  }
}
