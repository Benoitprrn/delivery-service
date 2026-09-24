import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import {
  DecideDriverReversalUseCase, ExecuteDriverReversalsUseCase, InvalidReversalReasonError, PostgresDriverReversalRepository, RequestDriverReversalUseCase, ReversalApproverError, ReversalNotPendingError, ReversalRefusedError,
  ReversalRejectedError, ReversalTransientError, RestaurantDefaultReversalForbiddenError,
  type DriverReversalProvider, type StripeBalanceView, type StripeReversalView, type StripeTransferView
} from '../../src/modules/settlements/public.js'
import { closeNotifyAndDebit, count, driverId, dropSettlementWorldFixtures, later, PAYRUN, payouts, resetSettlementWorld, settleDebits, type World } from '../support/settlement-payout-world.js'
import { silentLogger } from '../support/settlement-fakes.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise. Transfers réels (R60) sur PostgreSQL, Stripe simulé. Un Transfer de 475 c (restaurant 1) et un de 909 c (restaurant 2) sont déjà envoyés au livreur 1.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const REQUESTER = 'aaaaaaaa-0000-4000-8000-000000000001'
const APPROVER = 'aaaaaaaa-0000-4000-8000-000000000002'
const AFTER_PAYRUN = later(PAYRUN, 60)
let release: (() => Promise<void>) | undefined

class FakeReversals implements DriverReversalProvider {
  public readonly livemode = false
  public readonly creates: Array<{ key: string; transferId: string; amountCents: number; reversalRowId: string }> = []
  public readonly balances = new Map<string, StripeBalanceView>()
  public reversedByTransfer = new Map<string, number>()
  public onCreate: ((rowId: string) => Promise<void>) | null = null
  public loseResponseOnce = false
  public transferAmountOverride: number | null = null
  private readonly byKey = new Map<string, StripeReversalView>()
  private readonly byRow = new Map<string, StripeReversalView>()
  public constructor(private readonly world: World) {}

  public async retrieveTransfer(transferId: string): Promise<StripeTransferView> {
    const t = this.world.transfers.created.find((x) => x.transferId === transferId)!
    return { transferId, amountCents: this.transferAmountOverride ?? t.amountCents, amountReversedCents: this.reversedByTransfer.get(transferId) ?? 0, destinationAccountId: t.destinationAccountId, sourceTransactionId: t.sourceTransactionId, livemode: false }
  }
  public async retrieveDriverBalance(accountId: string): Promise<StripeBalanceView> { return this.balances.get(accountId) ?? { availableCents: 0, pendingCents: 0 } }
  public async createReversal(input: Parameters<DriverReversalProvider['createReversal']>[0]): Promise<StripeReversalView> {
    const rowId = input.metadata.driver_transfer_reversal_id
    const existing = this.byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    if (this.onCreate !== null) await this.onCreate(rowId)
    const t = this.world.transfers.created.find((x) => x.transferId === input.transferId)!
    const remaining = t.amountCents - (this.reversedByTransfer.get(input.transferId) ?? 0)
    if (input.amountCents > remaining) throw new ReversalRejectedError('invalid_request')
    this.creates.push({ key: input.idempotencyKey, transferId: input.transferId, amountCents: input.amountCents, reversalRowId: rowId })
    const reversal: StripeReversalView = { reversalId: `trr_fake_${this.creates.length}`, transferId: input.transferId, amountCents: input.amountCents }
    this.byKey.set(input.idempotencyKey, reversal)
    this.byRow.set(rowId, reversal)
    this.reversedByTransfer.set(input.transferId, (this.reversedByTransfer.get(input.transferId) ?? 0) + input.amountCents)
    if (this.loseResponseOnce) { this.loseResponseOnce = false; throw new ReversalTransientError('api_connection_error') }
    return reversal
  }
  public async findReversal(input: { transferId: string; reversalId: string }): Promise<StripeReversalView | null> { return this.byRow.get(input.reversalId) ?? null }
}

interface Paid { world: World; stripe: FakeReversals; transfer1: { id: string; stripeId: string; order: string; account: string }; transfer2: { id: string; stripeId: string; order: string }; request: RequestDriverReversalUseCase; decide: DecideDriverReversalUseCase; execute: ExecuteDriverReversalsUseCase }

async function paidWorld(availableOn = '2026-09-28T00:00:00Z'): Promise<Paid> {
  const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909]])
  await settleDebits(world, { 1: 'succeeded', 2: 'succeeded' })
  await pool.query('update debit_attempts set available_on = $1::timestamptz', [availableOn])
  await payouts(world).execute({ now: PAYRUN })
  const rows = (await pool.query<{ id: string; stripe: string; order_id: string; name: string }>(
    `select t.id, t.stripe_transfer_id as stripe, l.order_id, m.name from driver_transfers t join settlement_statements st on st.id = t.statement_id join merchants m on m.id = st.merchant_id
       join settlement_lines l on l.statement_id = st.id where t.status = 'succeeded' order by m.name`)).rows
  const repository = new PostgresDriverReversalRepository(pool)
  const stripe = new FakeReversals(world)
  const acct = 'acct_driver_1'
  stripe.balances.set(acct, { availableCents: 0, pendingCents: 1108 })
  return {
    world, stripe, transfer1: { id: rows[0]!.id, stripeId: rows[0]!.stripe, order: rows[0]!.order_id, account: acct }, transfer2: { id: rows[1]!.id, stripeId: rows[1]!.stripe, order: rows[1]!.order_id },
    request: new RequestDriverReversalUseCase(repository), decide: new DecideDriverReversalUseCase(repository),
    execute: new ExecuteDriverReversalsUseCase(repository, stripe, silentLogger, { retrySeconds: 60 })
  }
}

async function approvedReversal(p: Paid, over: { transferId?: string; amountCents?: number; reference?: string; reasonCode?: string; category?: string; orderId?: string | null } = {}): Promise<string> {
  const requested = await p.request.execute({
    driverTransferId: over.transferId ?? p.transfer1.id, category: over.category ?? 'driver_fault', reasonCode: over.reasonCode ?? 'order_stolen', reason: 'Colis non remis, déclaration de vol validée',
    decisionReference: over.reference ?? `DEC-${randomUUID()}`, amountCents: over.amountCents ?? 380, orderId: over.orderId === undefined ? p.transfer1.order : over.orderId, requestedBy: REQUESTER
  })
  await p.decide.approve({ reversalId: requested.reversal.id, approvedBy: APPROVER, now: AFTER_PAYRUN })
  return requested.reversal.id
}
const reversalRow = async (id: string): Promise<Record<string, unknown>> => (await pool.query(
  `select status, reversed_cents::int as reversed, planned_reverse_cents::int as planned_reverse, planned_receivable_cents::int as planned_receivable, funds_bucket, stripe_reversal_id, failure_code, attempt_count, decided_at is not null as decided,
          balance_available_before_cents::int as avail_before, balance_pending_before_cents::int as pend_before, stripe_amount_reversed_before_cents::int as stripe_before
     from driver_transfer_reversals where id = $1::uuid`, [id])).rows[0]
const receivables = async (): Promise<Array<Record<string, unknown>>> => (await pool.query('select driver_id, amount_cents::int as amount, status, driver_transfer_reversal_id as reversal from driver_receivables order by amount_cents')).rows

beforeAll(async () => { if (isolated) release = await lockSettlementSingleton(pool) })
afterEach(async () => { if (isolated) await resetSettlementWorld() })
afterAll(async () => {
  if (!isolated) return
  await dropSettlementWorldFixtures()
  await release?.()
})

describe.skipIf(!isolated)('driver reversals on PostgreSQL (R61, categories B and C only)', () => {
  it('example 1: the driver still holds the funds (pending) => the full amount is reversed at Stripe, after the decision is persisted, and no receivable is created', async () => {
    const p = await paidWorld()
    const id = await approvedReversal(p)
    let persistedBeforeStripe: Record<string, unknown> | null = null
    p.stripe.onCreate = async (rowId) => { persistedBeforeStripe = await reversalRow(rowId) }

    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, reversedCents: 380, receivablesCents: 0 })
    // La décision (plan + soldes lus + montant déjà reversé chez Stripe) était en base AVANT l'appel Stripe.
    expect(persistedBeforeStripe).toMatchObject({ status: 'executing', planned_reverse: 380, planned_receivable: 0, funds_bucket: 'pending', pend_before: 1108, avail_before: 0, stripe_before: 0, decided: true })
    expect(p.stripe.creates).toEqual([{ key: `reversal:${id}`, transferId: p.transfer1.stripeId, amountCents: 380, reversalRowId: id }])
    expect(await reversalRow(id)).toMatchObject({ status: 'succeeded', reversed: 380, stripe_reversal_id: 'trr_fake_1', planned_receivable: 0 })
    expect(await receivables()).toEqual([])
    // Le Transfer et le statement restent tels quels : la reversal ne rouvre pas la dette, R60 ne re-paie rien.
    expect(await count("select count(*) c from driver_transfers where status = 'succeeded'")).toBe(2)
    await expect(payouts(p.world).execute({ now: later(PAYRUN, 48 * 60) })).resolves.toMatchObject({ transferred: 0 })
  })

  it('example 2: the driver already received his bank payout (nothing recoverable) => NO Stripe call, the whole amount becomes an open driver receivable, no negative balance is caused', async () => {
    const p = await paidWorld('2026-09-10T00:00:00Z') // charge disponible : les fonds sont dans « available », déjà versés en banque
    p.stripe.balances.set('acct_driver_1', { availableCents: 0, pendingCents: 0 })
    const id = await approvedReversal(p)
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ succeeded: 1, reversedCents: 0, receivablesCents: 380 })
    expect(p.stripe.creates).toHaveLength(0)
    expect(await reversalRow(id)).toMatchObject({ status: 'succeeded', reversed: 0, planned_reverse: 0, planned_receivable: 380, funds_bucket: 'available', stripe_reversal_id: null })
    expect(await receivables()).toMatchObject([{ driver_id: driverId(1), amount: 380, status: 'open', reversal: id }])
  })

  it('example 3: partial reversals — by decision (150 then 325 of 475, then no more) and by insufficient balance (120 recoverable of 300 => 120 reversed + 180 receivable)', async () => {
    const p = await paidWorld()
    const first = await approvedReversal(p, { amountCents: 150 })
    const second = await approvedReversal(p, { amountCents: 325 })
    await expect(p.request.execute({ driverTransferId: p.transfer1.id, category: 'driver_fault', reasonCode: 'fraud', reason: 'x', decisionReference: 'DEC-TOO-MUCH', amountCents: 1, requestedBy: REQUESTER })).rejects.toMatchObject({ reason: 'amount_exceeds_transfer' })
    // Une seule reversal en exécution par livreur : la seconde attend le cycle suivant (jamais deux décisions sur le même solde).
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, reversedCents: 150 })
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60 + 1) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, reversedCents: 325 })
    expect(await reversalRow(first)).toMatchObject({ status: 'succeeded', reversed: 150 })
    expect(await reversalRow(second)).toMatchObject({ status: 'succeeded', reversed: 325, stripe_before: 150 }) // la 2ᵉ décision tient compte de ce que Stripe a déjà reversé
    expect(p.stripe.reversedByTransfer.get(p.transfer1.stripeId)).toBe(475)

    // Solde insuffisant : dans « available » il ne reste que 120 c pour reverser 300 c du Transfer n°2.
    await pool.query("update debit_attempts set available_on = '2026-09-10T00:00:00Z'")
    p.stripe.balances.set('acct_driver_1', { availableCents: 120, pendingCents: 500 })
    const partial = await approvedReversal(p, { transferId: p.transfer2.id, amountCents: 300, reasonCode: 'order_damaged', orderId: p.transfer2.order })
    await expect(p.execute.execute({ now: later(PAYRUN, 48 * 60) })).resolves.toMatchObject({ succeeded: 1, reversedCents: 120, receivablesCents: 180 })
    expect(p.stripe.creates.at(-1)).toMatchObject({ amountCents: 120 }) // jamais 300 : pas de solde négatif provoqué
    expect(await reversalRow(partial)).toMatchObject({ status: 'succeeded', reversed: 120, planned_reverse: 120, planned_receivable: 180, funds_bucket: 'available', avail_before: 120 })
    expect(await receivables()).toMatchObject([{ amount: 180, status: 'open', reversal: partial }])
  })

  it('prevents duplicates: an idempotent request, a conflicting reuse of a decision reference, and concurrent workers', async () => {
    const p = await paidWorld()
    const input = { driverTransferId: p.transfer1.id, category: 'driver_fault', reasonCode: 'order_lost', reason: 'Colis perdu', decisionReference: 'DEC-42', amountCents: 200, orderId: p.transfer1.order, requestedBy: REQUESTER }
    const a = await p.request.execute(input)
    const b = await p.request.execute(input)
    expect([a.outcome, b.outcome]).toEqual(['created', 'duplicate'])
    expect(b.reversal.id).toBe(a.reversal.id)
    await expect(p.request.execute({ ...input, amountCents: 201 })).rejects.toBeInstanceOf(ReversalRefusedError)
    expect(await count('select count(*) c from driver_transfer_reversals')).toBe(1)

    await p.decide.approve({ reversalId: a.reversal.id, approvedBy: APPROVER, now: AFTER_PAYRUN })
    await expect(p.decide.approve({ reversalId: a.reversal.id, approvedBy: APPROVER, now: AFTER_PAYRUN })).rejects.toBeInstanceOf(ReversalNotPendingError)
    await Promise.all([1, 2, 3].map(() => p.execute.execute({ now: later(PAYRUN, 24 * 60) })))
    expect(p.stripe.creates).toHaveLength(1)
    expect(await reversalRow(a.reversal.id)).toMatchObject({ status: 'succeeded', reversed: 200 })
  })

  it('survives a lost Stripe response: the decided plan is REUSED (not recomputed), the existing Stripe reversal is found, and only one exists', async () => {
    const p = await paidWorld()
    const id = await approvedReversal(p)
    p.stripe.loseResponseOnce = true
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ claimed: 1, retryable: 1, succeeded: 0 })
    expect(await reversalRow(id)).toMatchObject({ status: 'executing', planned_reverse: 380, reversed: null })
    // Entre-temps le solde du livreur a changé : le plan figé ne bouge pas.
    p.stripe.balances.set('acct_driver_1', { availableCents: 0, pendingCents: 0 })
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60 + 5) })).resolves.toMatchObject({ claimed: 1, succeeded: 1, reversedCents: 380 })
    expect(p.stripe.creates).toHaveLength(1)
    expect(p.stripe.reversedByTransfer.get(p.transfer1.stripeId)).toBe(380)
    expect(await reversalRow(id)).toMatchObject({ status: 'succeeded', reversed: 380, planned_reverse: 380, attempt_count: 2 })
  })

  it('refuses anything outside categories B and C: a restaurant failure/dispute, unknown reasons, a missing order, another order, a self-approval, a transfer that did not succeed', async () => {
    const p = await paidWorld()
    const base = { driverTransferId: p.transfer1.id, category: 'driver_fault', reasonCode: 'order_stolen', reason: 'vol', decisionReference: 'DEC-X', amountCents: 100, orderId: p.transfer1.order, requestedBy: REQUESTER }
    for (const category of ['restaurant_default', 'restaurant_dispute', 'sepa_return', 'unpaid_restaurant']) await expect(p.request.execute({ ...base, category })).rejects.toBeInstanceOf(RestaurantDefaultReversalForbiddenError)
    for (const reasonCode of ['restaurant_default', 'sepa_failure', 'merchant_dispute', 'impayé']) await expect(p.request.execute({ ...base, reasonCode })).rejects.toBeInstanceOf(RestaurantDefaultReversalForbiddenError)
    await expect(p.request.execute({ ...base, reasonCode: 'wrong_amount' })).rejects.toBeInstanceOf(InvalidReversalReasonError) // motif de l'autre catégorie
    await expect(p.request.execute({ ...base, reasonCode: 'made_up' })).rejects.toBeInstanceOf(InvalidReversalReasonError)
    await expect(p.request.execute({ ...base, orderId: null })).rejects.toBeInstanceOf(InvalidReversalReasonError) // « commande volée » exige la commande
    await expect(p.request.execute({ ...base, orderId: p.transfer2.order })).rejects.toMatchObject({ reason: 'order_not_in_statement' }) // commande d'un autre statement
    await expect(p.request.execute({ ...base, reason: '  ' })).rejects.toBeDefined()
    await expect(p.request.execute({ ...base, decisionReference: '' })).rejects.toBeDefined()
    await expect(p.request.execute({ ...base, amountCents: 0 })).rejects.toBeDefined()
    await expect(p.request.execute({ ...base, driverTransferId: randomUUID() })).rejects.toMatchObject({ reason: 'transfer_not_reversible' })
    expect(await count('select count(*) c from driver_transfer_reversals')).toBe(0)

    const created = await p.request.execute(base)
    await expect(p.decide.approve({ reversalId: created.reversal.id, approvedBy: REQUESTER, now: AFTER_PAYRUN })).rejects.toBeInstanceOf(ReversalApproverError)
    await p.decide.reject({ reversalId: created.reversal.id, rejectedBy: APPROVER, reason: 'décision non confirmée', now: AFTER_PAYRUN })
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ claimed: 0 }) // une reversal rejetée ou non approuvée n'est jamais exécutée
    expect(p.stripe.creates).toHaveLength(0)
  })

  it('never calls Stripe blindly: a ledger/Stripe divergence or a mismatching Stripe transfer fails the reversal with NO Stripe change and NO receivable', async () => {
    const p = await paidWorld()
    p.stripe.reversedByTransfer.set(p.transfer1.stripeId, 100) // quelqu'un a reversé 100 c hors de notre ledger
    const diverged = await approvedReversal(p)
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60) })).resolves.toMatchObject({ failed: 1, succeeded: 0 })
    expect(await reversalRow(diverged)).toMatchObject({ status: 'failed', failure_code: 'technical:ledger_mismatch', planned_reverse: null })

    p.stripe.reversedByTransfer.clear()
    p.stripe.transferAmountOverride = 999 // Stripe décrit un autre montant que notre Transfer
    const mismatching = await approvedReversal(p, { transferId: p.transfer2.id, amountCents: 100, orderId: p.transfer2.order })
    await expect(p.execute.execute({ now: later(PAYRUN, 24 * 60 + 1) })).resolves.toMatchObject({ failed: 1 })
    expect(await reversalRow(mismatching)).toMatchObject({ status: 'failed', failure_code: 'technical:transfer_mismatch' })
    expect(p.stripe.creates).toHaveLength(0)
    expect(await receivables()).toEqual([])
  })

  it('the database freezes the decision and the receivable: no edit after request, no forged receivable, no succeeded reversal without its exact receivable', async () => {
    const p = await paidWorld()
    const id = await approvedReversal(p)
    await expect(pool.query('update driver_transfer_reversals set amount_cents = 1 where id = $1::uuid', [id])).rejects.toThrow(/immuable/)
    await expect(pool.query("update driver_transfer_reversals set reason_code = 'fraud' where id = $1::uuid", [id])).rejects.toThrow(/immuable/)
    await expect(pool.query("update driver_transfer_reversals set decision_reference = 'OTHER' where id = $1::uuid", [id])).rejects.toThrow(/immuable/)
    await expect(pool.query('insert into driver_receivables(driver_id, driver_transfer_reversal_id, amount_cents) values($1::uuid, $2::uuid, 10)', [driverId(1), id])).rejects.toThrow(/reversal réussie/)
    // Réussite déclarée sans plan ni reliquat cohérent : refusée.
    await expect(pool.query("update driver_transfer_reversals set status = 'succeeded', reversed_cents = 380, executed_at = now() where id = $1::uuid", [id])).rejects.toThrow()
    // Plan 0 reversé / 380 reliquat mais aucune créance : la contrainte différée refuse la transaction.
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("update driver_transfer_reversals set status = 'executing', claim_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute', planned_reverse_cents = 0, planned_receivable_cents = 380, decided_at = now(), funds_bucket = 'available', stripe_amount_reversed_before_cents = 0 where id = $1::uuid", [id])
      await client.query("update driver_transfer_reversals set status = 'succeeded', reversed_cents = 0, executed_at = now(), claim_token = null, lease_expires_at = null where id = $1::uuid", [id])
      await expect(client.query('commit')).rejects.toThrow(/créance livreur/)
    } finally {
      await client.query('rollback').catch(() => undefined)
      client.release()
    }
    expect(await reversalRow(id)).toMatchObject({ status: 'approved' })
  })
})
