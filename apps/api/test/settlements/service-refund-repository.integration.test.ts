import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import {
  DecideDriverReversalUseCase, ExecuteDriverReversalsUseCase, PostgresDriverReversalRepository, PostgresServiceRefundRepository, RequestDriverReversalUseCase, RunServiceRefundsUseCase,
  ServiceRefundTransientError, type DriverReversalProvider, type MerchantServiceRefundProvider, type StripeBalanceView, type StripeRefundView, type StripeReversalView, type StripeTransferView
} from '../../src/modules/settlements/public.js'
import { closeNotifyAndDebit, dropSettlementWorldFixtures, later, PAYRUN, payouts, resetSettlementWorld, settleDebits, type World } from '../support/settlement-payout-world.js'
import { silentLogger } from '../support/settlement-fakes.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise. `retryLater()` (PostgresServiceRefundRepository) n'était exercée par AUCUN test contre du vrai
// PostgreSQL avant SF13 (seul domain/service-refund.test.ts existait, avec un repository entièrement FAKE) — un vrai
// replay Stripe Sandbox (SF13) a trouvé un bug réel dans cette requête (paramètre $5 non typé dans une expression
// arithmétique `$5 + make_interval(...)`, cassant l'inférence de type PostgreSQL) que ce test verrouille.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const REQUESTER = 'aaaaaaaa-0000-4000-8000-000000000003'
const APPROVER = 'aaaaaaaa-0000-4000-8000-000000000004'
const AFTER_PAYRUN = later(PAYRUN, 60)
let release: (() => Promise<void>) | undefined

class FakeReversals implements DriverReversalProvider {
  public readonly livemode = false
  private readonly byKey = new Map<string, StripeReversalView>()
  public constructor(private readonly world: World) {}
  public async retrieveTransfer(transferId: string): Promise<StripeTransferView> {
    const t = this.world.transfers.created.find((x) => x.transferId === transferId)!
    return { transferId, amountCents: t.amountCents, amountReversedCents: 0, destinationAccountId: t.destinationAccountId, sourceTransactionId: t.sourceTransactionId, livemode: false }
  }
  public async retrieveDriverBalance(): Promise<StripeBalanceView> { return { availableCents: 0, pendingCents: this.world.transfers.created[0]!.amountCents } }
  public async createReversal(input: Parameters<DriverReversalProvider['createReversal']>[0]): Promise<StripeReversalView> {
    const existing = this.byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    const reversal: StripeReversalView = { reversalId: `trr_fake_${this.byKey.size + 1}`, transferId: input.transferId, amountCents: input.amountCents }
    this.byKey.set(input.idempotencyKey, reversal)
    return reversal
  }
  public async findReversal(): Promise<StripeReversalView | null> { return null }
}

/** Échoue une fois (erreur Stripe transitoire), réussit ensuite — force `RunServiceRefundsUseCase` à emprunter `retryLater()`. */
class FlakyRefunds implements MerchantServiceRefundProvider {
  public readonly livemode = false
  public attempts = 0
  public async createRefund(input: Parameters<MerchantServiceRefundProvider['createRefund']>[0]): Promise<StripeRefundView> {
    this.attempts += 1
    if (this.attempts === 1) throw new ServiceRefundTransientError('api_connection_error')
    return { refundId: 'pyr_fake_1', chargeId: input.chargeId, amountCents: input.amountCents, status: 'succeeded' }
  }
  public async findRefund(): Promise<StripeRefundView | null> { return null }
}

beforeAll(async () => { if (isolated) release = await lockSettlementSingleton(pool) })
afterEach(async () => { if (isolated) await resetSettlementWorld() })
afterAll(async () => {
  if (!isolated) return
  await dropSettlementWorldFixtures()
  await release?.()
})

describe.skipIf(!isolated)('service refund repository on PostgreSQL (SF9.5 — real retry path)', () => {
  it('retryLater() sets a future next_attempt_at (real Postgres, no type-inference error) and the refund succeeds on the next attempt', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    await settleDebits(world, { 1: 'succeeded' })
    await pool.query("update debit_attempts set available_on = '2026-09-28T00:00:00Z'::timestamptz")
    await payouts(world).execute({ now: PAYRUN })
    const transferRow = (await pool.query<{ id: string; stripe: string; order_id: string }>(
      `select t.id, t.stripe_transfer_id as stripe, l.order_id from driver_transfers t join settlement_statements st on st.id = t.statement_id
         join settlement_lines l on l.statement_id = st.id where t.status = 'succeeded' limit 1`)).rows[0]!

    const reversalRepo = new PostgresDriverReversalRepository(pool)
    const stripeReversals = new FakeReversals(world)
    const request = new RequestDriverReversalUseCase(reversalRepo)
    const decide = new DecideDriverReversalUseCase(reversalRepo)
    const execute = new ExecuteDriverReversalsUseCase(reversalRepo, stripeReversals, silentLogger, { retrySeconds: 60 })
    const requested = await request.execute({ driverTransferId: transferRow.id, category: 'driver_fault', reasonCode: 'order_stolen', reason: 'Test SF13 retryLater', decisionReference: 'SF13-RETRY-TEST', amountCents: 475, orderId: transferRow.order_id, requestedBy: REQUESTER })
    await decide.approve({ reversalId: requested.reversal.id, approvedBy: APPROVER, now: AFTER_PAYRUN })
    await expect(execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, reversedCents: 475, receivablesCents: 0 })

    const refundRepo = new PostgresServiceRefundRepository(pool)
    const flaky = new FlakyRefunds()
    const runRefunds = new RunServiceRefundsUseCase(refundRepo, flaky, silentLogger, { retrySeconds: 3600 })

    // 1er passage : Stripe échoue -> retryLater() doit écrire un next_attempt_at dans le FUTUR sans lever d'erreur SQL.
    await expect(runRefunds.execute({ now: later(PAYRUN, 25 * 60) })).resolves.toMatchObject({ claimed: 1, succeeded: 0, failed: 0, retryable: 1 })
    const row = (await pool.query<{ status: string; next_attempt_at: string | null; claim_token: string | null; last_error_class: string | null }>(
      "select status, next_attempt_at, claim_token, last_error_class from driver_reversal_service_refunds where order_id = $1::uuid", [transferRow.order_id])).rows[0]!
    expect(row.status).toBe('executing')
    expect(row.claim_token).toBeNull()
    expect(row.last_error_class).toBe('api_connection_error')
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(later(PAYRUN, 25 * 60).getTime())

    // Trop tôt (avant next_attempt_at) : rien à réclamer, pas de second appel Stripe.
    await expect(runRefunds.execute({ now: later(PAYRUN, 25 * 60 + 1) })).resolves.toMatchObject({ claimed: 0 })
    expect(flaky.attempts).toBe(1)

    // 2e passage, après next_attempt_at : succès.
    await expect(runRefunds.execute({ now: later(PAYRUN, 27 * 60) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retryable: 0 })
    const finalRow = (await pool.query<{ status: string; stripe_refund_id: string | null; refund_cents: string }>(
      "select status, stripe_refund_id, refund_cents::text from driver_reversal_service_refunds where order_id = $1::uuid", [transferRow.order_id])).rows[0]!
    expect(finalRow.status).toBe('succeeded')
    expect(finalRow.stripe_refund_id).toBe('pyr_fake_1')
    expect(finalRow.refund_cents).toBe('95') // floor(475 * 2000 / 10000) — reversal totale, formule SF9.5
  })
})
