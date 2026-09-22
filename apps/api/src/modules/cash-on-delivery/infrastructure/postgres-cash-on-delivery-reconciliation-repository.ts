import type { Pool, PoolClient } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import type { CashOnDeliveryPaymentStatus } from '../domain/cash-on-delivery-payment-state-machine.js'
import type { CompletionSessionStatus } from '../domain/completion-session-state-machine.js'
import type { CashOnDeliveryReconciliationPolicy } from '../domain/reconciliation-policy.js'
import type { CashOnDeliveryPayment } from '../ports/cash-on-delivery-payment-repository.js'
import type {
  CashOnDeliveryReconciliationRepository,
  CompleteCapturedPaymentResult,
  ReconciliationSubject,
  RecordCaptureWithoutCompletionResult
} from '../ports/cash-on-delivery-reconciliation-repository.js'
import { ACTIVE_PAYMENT_STATUSES } from '../application/reconciliation-decision.js'

type Row = Record<string, unknown>

const UNIQUE_VIOLATION = '23505'

function mapSubject(row: Row): ReconciliationSubject {
  const payment: CashOnDeliveryPayment = {
    id: String(row.id),
    orderId: String(row.order_id),
    sessionId: String(row.session_id),
    merchantId: String(row.merchant_id),
    driverId: String(row.driver_id),
    attemptNo: Number(row.attempt_no),
    stripeAccountId: String(row.stripe_account_id),
    amountCents: Number(row.amount_cents),
    currency: 'eur',
    stripePaymentIntentId: row.stripe_payment_intent_id as string | null,
    stripeChargeId: row.stripe_charge_id as string | null,
    status: row.status as CashOnDeliveryPaymentStatus,
    captureIdempotencyKey: String(row.capture_idempotency_key),
    createIdempotencyKey: String(row.create_idempotency_key),
    readerType: row.reader_type as CashOnDeliveryPayment['readerType'],
    readerSerial: row.reader_serial as string | null,
    terminalLocationId: String(row.terminal_location_id),
    failureCode: row.failure_code as string | null,
    declineCode: row.decline_code as string | null
  }
  return {
    payment,
    session: {
      id: String(row.session_id),
      status: row.session_status as CompletionSessionStatus,
      expiresAt: row.session_expires_at as Date,
      expectedOrderVersion: Number(row.session_expected_order_version)
    },
    sessionAbandoned: row.session_abandoned === true
  }
}

const SUBJECT_COLUMNS = `
  s.status as session_status,
  s.expires_at as session_expires_at,
  s.expected_order_version as session_expected_order_version,
  (s.expires_at <= now() - make_interval(secs => $1)) as session_abandoned`

export class PostgresCashOnDeliveryReconciliationRepository implements CashOnDeliveryReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  async claimStale(input: { limit: number; policy: CashOnDeliveryReconciliationPolicy }): Promise<ReconciliationSubject[]> {
    const { policy } = input
    // Une seule instruction : sélection `SKIP LOCKED` + bail (`updated_at = now()`).
    // Le délai de reprise croît avec l'âge du paiement (âge / 4), entre min et max.
    // Les paiements `failed`/`canceled` portant un PaymentIntent ne sont revus que
    // pendant la fenêtre d'autorisation Stripe (annulation « au mieux » échouée).
    const result = await this.pool.query<Row>(
      `with candidate as (
         select p.id
         from order_cash_on_delivery_payments p
         join order_delivery_completion_sessions s on s.id = p.session_id
         where (
             (p.status = any($6::text[]) and s.expires_at <= now() - make_interval(secs => $1))
             or (
               p.status in ('failed', 'canceled')
               and p.stripe_payment_intent_id is not null
               and coalesce(p.canceled_at, p.failed_at) > now() - make_interval(secs => $4)
             )
           )
           and p.updated_at <= now() - least(
             make_interval(secs => $3),
             greatest(make_interval(secs => $2), (now() - p.created_at) / 4)
           )
         order by p.updated_at, p.id
         limit $5
         for update of p skip locked
       ),
       claimed as (
         update order_cash_on_delivery_payments p
         set updated_at = now()
         from candidate c
         where p.id = c.id
         returning p.*
       )
       select claimed.*, ${SUBJECT_COLUMNS}
       from claimed
       join order_delivery_completion_sessions s on s.id = claimed.session_id
       order by claimed.created_at, claimed.id`,
      [
        policy.sessionGraceSeconds,
        policy.minRetrySeconds,
        policy.maxRetrySeconds,
        policy.terminalRecheckWindowSeconds,
        input.limit,
        [...ACTIVE_PAYMENT_STATUSES]
      ]
    )
    return result.rows.map(mapSubject)
  }

  async findByPaymentIntentId(paymentIntentId: string, policy: CashOnDeliveryReconciliationPolicy): Promise<ReconciliationSubject | null> {
    const result = await this.pool.query<Row>(
      `select p.*, ${SUBJECT_COLUMNS}
       from order_cash_on_delivery_payments p
       join order_delivery_completion_sessions s on s.id = p.session_id
       where p.stripe_payment_intent_id = $2`,
      [policy.sessionGraceSeconds, paymentIntentId]
    )
    return result.rows[0] === undefined ? null : mapSubject(result.rows[0])
  }

  async findByPaymentId(paymentId: string, policy: CashOnDeliveryReconciliationPolicy): Promise<ReconciliationSubject | null> {
    const result = await this.pool.query<Row>(
      `select p.*, ${SUBJECT_COLUMNS}
       from order_cash_on_delivery_payments p
       join order_delivery_completion_sessions s on s.id = p.session_id
       where p.id = $2`,
      [policy.sessionGraceSeconds, paymentId]
    )
    return result.rows[0] === undefined ? null : mapSubject(result.rows[0])
  }

  async transitionPayment(input: {
    paymentId: string
    from: readonly CashOnDeliveryPaymentStatus[]
    to: CashOnDeliveryPaymentStatus
    failureCode?: string | null
    declineCode?: string | null
  }): Promise<boolean> {
    const result = await this.pool.query(
      `update order_cash_on_delivery_payments
       set status = $3,
           failure_code = case when $3 = 'failed' then $4 else failure_code end,
           decline_code = case when $3 = 'failed' then $5 else decline_code end,
           authorized_at = case when $3 = 'authorized' then now() else authorized_at end,
           failed_at = case when $3 = 'failed' then now() else failed_at end,
           canceled_at = case when $3 = 'canceled' then now() else canceled_at end,
           updated_at = now()
       where id = $1 and status = any($2::text[])`,
      [input.paymentId, [...input.from], input.to, input.failureCode ?? null, input.declineCode ?? null]
    )
    return result.rowCount === 1
  }

  async completeCapturedPayment(input: {
    paymentId: string
    sessionId: string
    chargeId: string | null
    completeOrder: (client: PoolClient) => Promise<unknown>
  }): Promise<CompleteCapturedPaymentResult> {
    return inTransaction(this.pool, async (client) => {
      // Même ordre de verrous que `finalize` : paiement, session, commande.
      const captured = await client.query(
        `update order_cash_on_delivery_payments
         set status = 'captured', stripe_charge_id = coalesce($2, stripe_charge_id),
             captured_at = now(), updated_at = now()
         where id = $1 and status = any($3::text[])`,
        [input.paymentId, input.chargeId, [...ACTIVE_PAYMENT_STATUSES]]
      )
      if (captured.rowCount !== 1) return 'payment_not_active' as const
      // Verrou de session avant la commande (ordre de `finalize`). Aucun passage par
      // `payment_succeeded` : ce statut est « actif » et heurterait l'index unique d'une
      // éventuelle session de reprise, alors que la réalité Stripe prime.
      await client.query('select id from order_delivery_completion_sessions where id = $1 for update', [input.sessionId])
      await input.completeOrder(client)
      await client.query(
        `update order_delivery_completion_sessions
         set status = 'completed', completed_at = now(), updated_at = now()
         where id = $1 and status <> 'completed'`,
        [input.sessionId]
      )
      return 'completed' as const
    })
  }

  async recordCaptureWithoutCompletion(input: { paymentId: string; chargeId: string | null }): Promise<RecordCaptureWithoutCompletionResult> {
    try {
      const result = await this.pool.query(
        `update order_cash_on_delivery_payments
         set status = 'captured', stripe_charge_id = coalesce($2, stripe_charge_id),
             captured_at = now(), updated_at = now()
         where id = $1 and status = any($3::text[])`,
        [input.paymentId, input.chargeId, [...ACTIVE_PAYMENT_STATUSES]]
      )
      return result.rowCount === 1 ? 'recorded' : 'payment_not_active'
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'duplicate_capture'
      throw error
    }
  }
}
