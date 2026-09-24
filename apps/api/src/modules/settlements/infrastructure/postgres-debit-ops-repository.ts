import type { Pool, PoolClient } from 'pg'
import type { ChargeIncidentAssessment } from '../domain/charge-incident.js'
import type { DebitAttemptRef, DebitOpsRepository } from '../ports/settlement-ops.js'

export class PostgresDebitOpsRepository implements DebitOpsRepository {
  public constructor(private readonly pool: Pool) {}

  public async findAttempt(ids: { paymentIntentId: string | null; chargeId: string | null }): Promise<DebitAttemptRef | null> {
    const result = await this.pool.query<{ id: string; merchant_settlement_id: string; status: string }>(
      `select id, merchant_settlement_id, status from debit_attempts
        where ($1::text is not null and stripe_payment_intent_id = $1) or ($2::text is not null and stripe_charge_id = $2)
        order by attempt_no desc limit 1`,
      [ids.paymentIntentId, ids.chargeId]
    )
    const row = result.rows[0]
    return row === undefined ? null : { id: row.id, merchantSettlementId: row.merchant_settlement_id, status: row.status }
  }

  public async requestSync(attemptId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query("update debit_attempts set next_sync_at = $2::timestamptz, updated_at = now() where id = $1::uuid and status in ('creating','processing')", [attemptId, now])
    return result.rowCount === 1
  }

  public async knownSucceededServiceRefundCents(chargeId: string): Promise<number> {
    const result = await this.pool.query<{ cents: string }>("select coalesce(sum(refund_cents), 0)::text as cents from driver_reversal_service_refunds where stripe_charge_id = $1 and status = 'succeeded'", [chargeId])
    return Number(result.rows[0]?.cents ?? '0')
  }

  public async applyIncidents(input: { attemptId: string; chargeId: string; assessment: ChargeIncidentAssessment; now: Date }): Promise<{ applied: boolean; owedCents: number }> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const attempt = await client.query<{ merchant_settlement_id: string; merchant_id: string }>(
        `select a.merchant_settlement_id, ms.merchant_id from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where a.id = $1::uuid and a.status = 'succeeded' for update of a`,
        [input.attemptId]
      )
      const row = attempt.rows[0]
      if (row === undefined) { await client.query('rollback'); return { applied: false, owedCents: 0 } }
      for (const incident of input.assessment.incidents) await this.upsertIncident(client, input, row, incident)
      await this.syncStatements(client, row.merchant_settlement_id, input.assessment.chargeUsable)
      await client.query('commit')
      return { applied: true, owedCents: input.assessment.restaurantOwedCents }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async upsertIncident(client: PoolClient, input: { attemptId: string; chargeId: string; now: Date }, ctx: { merchant_settlement_id: string; merchant_id: string }, incident: ChargeIncidentAssessment['incidents'][number]): Promise<void> {
    if (incident.amountCents <= 0) return
    const upserted = await client.query<{ id: string }>(
      `insert into debit_incidents(debit_attempt_id, kind, external_id, stripe_charge_id, amount_cents, status, reason, detected_at, last_seen_at, resolved_at)
       values($1::uuid, $2, $3, $4, $5::bigint, $6, $7, $8::timestamptz, $8::timestamptz, case when $6 in ('won','closed') then $8::timestamptz end)
       on conflict (debit_attempt_id, external_id) do update
         set status = excluded.status, amount_cents = excluded.amount_cents, reason = coalesce(excluded.reason, debit_incidents.reason), last_seen_at = excluded.last_seen_at,
             resolved_at = case when excluded.status in ('won','closed') then coalesce(debit_incidents.resolved_at, excluded.resolved_at) else null end, updated_at = now()
       returning id`,
      [input.attemptId, incident.kind, incident.externalId, input.chargeId, incident.amountCents, incident.status, incident.reason, input.now]
    )
    const incidentId = upserted.rows[0]!.id
    // Créance du RESTAURANT (jamais une reversal livreur) : ouverte tant que le litige n'est pas gagné/clos, soldée sinon.
    const owed = incident.kind === 'refund' || incident.status === 'open' || incident.status === 'lost'
    await client.query(
      `insert into merchant_receivables(merchant_id, merchant_settlement_id, kind, amount_cents, status, stripe_charge_id, stripe_dispute_id, debit_incident_id)
       values($1::uuid, $2::uuid, $3, $4::bigint, $5, $6, $7, $8::uuid)
       on conflict (debit_incident_id) do update set amount_cents = excluded.amount_cents,
         status = case when merchant_receivables.status = 'written_off' then 'written_off' else excluded.status end, updated_at = now()`,
      [ctx.merchant_id, ctx.merchant_settlement_id, incident.kind === 'dispute' ? 'sepa_dispute' : 'sepa_refund', incident.amountCents, owed ? 'open' : 'recovered', input.chargeId, incident.kind === 'dispute' ? incident.externalId : null, incidentId]
    )
  }

  /** Statements NON payés d'un débit contesté/remboursé : dette du restaurant, aucun paiement livreur ; payés : inchangés (Locadely assume, D-O). */
  private async syncStatements(client: PoolClient, merchantSettlementId: string, chargeUsable: boolean): Promise<void> {
    if (!chargeUsable) {
      await client.query(
        "update settlement_statements set status = 'unpaid_restaurant', payout_hold_reason = 'debit_incident', updated_at = now() where merchant_settlement_id = $1::uuid and paid_cents < due_cents and status not in ('paid','partial')",
        [merchantSettlementId]
      )
    } else {
      await client.query(
        "update settlement_statements set status = 'succeeded_held', payout_hold_reason = null, payout_next_attempt_at = null, updated_at = now() where merchant_settlement_id = $1::uuid and payout_hold_reason = 'debit_incident' and status = 'unpaid_restaurant'",
        [merchantSettlementId]
      )
    }
  }
}
