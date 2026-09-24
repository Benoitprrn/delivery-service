import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { StatementDraft } from '../domain/period-ledger.js'
import type { ClosePeriodInput, SettlementCloseRepository, SettlementSettings } from '../ports/settlement-close.js'

type SettingsRow = { go_live_at: Date | null; payrun_delay_business_days: number; promise_business_days: number }

/**
 * Clôture d'une période (R40). Les horodatages des lignes sont lus EN SQL depuis `orders`/`order_events` (précision microseconde)
 * et jamais depuis un `Date` JavaScript (milliseconde) : le trigger de `settlement_lines` exige l'égalité exacte avec la commande.
 */
export class PostgresSettlementCloseRepository implements SettlementCloseRepository {
  public constructor(private readonly pool: Pool) {}

  public async readSettings(): Promise<SettlementSettings> {
    const result = await this.pool.query<SettingsRow>('select go_live_at, payrun_delay_business_days, promise_business_days from settlement_settings where id = true')
    const row = result.rows[0]
    if (row === undefined) throw new Error('settlement_settings singleton is missing')
    return { goLiveAt: row.go_live_at, payrunDelayBusinessDays: row.payrun_delay_business_days, promiseBusinessDays: row.promise_business_days }
  }

  public async isPeriodClosed(periodStart: Date): Promise<boolean> {
    const result = await this.pool.query<{ status: string }>('select status from settlement_periods where period_start = $1', [periodStart])
    return result.rows[0]?.status === 'closed'
  }

  public async closePeriod(input: ClosePeriodInput): Promise<'closed' | 'already_closed'> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      // Un seul clôtureur à la fois (plusieurs instances du worker) ; le verrou est libéré au COMMIT/ROLLBACK.
      await client.query("select pg_advisory_xact_lock(hashtextextended('settlement-period-close', 0))")
      const existing = await client.query<{ status: string }>('select status from settlement_periods where period_start = $1', [input.periodStart])
      if (existing.rows[0] !== undefined) {
        await client.query('rollback')
        if (existing.rows[0].status === 'closed') return 'already_closed'
        throw new Error(`settlement period exists with unexpected status ${existing.rows[0].status}`)
      }
      const periodId = randomUUID()
      await client.query(
        `insert into settlement_periods (id, period_start, period_end, status, closed_at, go_live_at_snapshot, excluded_orders_count, debit_date, payrun_at, promise_deadline)
         values ($1, $2, $3, 'closed', now(), (select go_live_at from settlement_settings where id = true), $4, $5::date, $6, $7::date)`,
        [periodId, input.periodStart, input.periodEnd, input.excludedOrdersCount, input.debitDate, input.payrunAtUtc, input.promiseDeadline]
      )
      for (const settlement of input.ledger.merchantSettlements) {
        const settlementId = randomUUID()
        await client.query('insert into merchant_settlements (id, period_id, merchant_id, amount_cents, driver_amount_cents, service_fee_cents) values ($1, $2, $3, $4, $5, $6)', [settlementId, periodId, settlement.merchantId, settlement.amountCents, settlement.driverAmountCents, settlement.serviceFeeCents])
        for (const statement of settlement.statements) {
          await this.insertStatement(client, { periodId, settlementId, statement })
        }
      }
      await client.query('commit') // les contraintes différées revérifient ici lignes ↔ statements ↔ règlements
      return 'closed'
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async insertStatement(client: PoolClient, input: { periodId: string; settlementId: string; statement: StatementDraft }): Promise<void> {
    const { statement } = input
    const statementId = randomUUID()
    await client.query(
      `insert into settlement_statements (id, period_id, driver_id, merchant_id, merchant_settlement_id, due_cents)
       values ($1, $2, $3, $4, $5, $6)`,
      [statementId, input.periodId, statement.driverId, statement.merchantId, input.settlementId, statement.dueCents]
    )
    await client.query(
      `insert into settlement_lines (statement_id, period_id, driver_id, merchant_id, order_id, final_status, finalized_at, order_created_at,
                                     delivery_cents, service_fee_cents, pricing_rule_version)
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, o.id, o.status::text,
              case when o.status = 'COMPLETED' then o.completed_at
                   else (select min(e.created_at) from order_events e where e.order_id = o.id and e.to_status = 'RETURNED') end,
              o.created_at, l.delivery_cents, l.service_fee_cents, l.pricing_rule_version
         from unnest($5::uuid[], $6::bigint[], $7::bigint[], $8::int[]) as l(order_id, delivery_cents, service_fee_cents, pricing_rule_version)
         join orders o on o.id = l.order_id`,
      [
        statementId, input.periodId, statement.driverId, statement.merchantId,
        statement.lines.map((line) => line.orderId),
        statement.lines.map((line) => line.deliveryCents),
        statement.lines.map((line) => line.serviceFeeCents),
        statement.lines.map((line) => line.pricingRuleVersion)
      ]
    )
  }
}
