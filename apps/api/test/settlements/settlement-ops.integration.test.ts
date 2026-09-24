import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import {
  DebitRetryNotAllowedError, PostgresDebitOpsRepository, PostgresDebitRetryRepository, PostgresPreNotificationRepository, PostgresReconciliationRepository, PostgresSepaDebitRepository, PostgresSettlementEventRepository, ProcessSettlementWebhooksUseCase,
  ReceiveSettlementWebhookUseCase, RequestDebitRetryUseCase, RunSepaDebitsUseCase, RunSettlementReconciliationUseCase, SendPreNotificationsUseCase,
  type ChargeIncidentReader, type ChargeIncidentView, type EmailSender, type ReconciliationStripeReader, type StripeDebitSnapshot, type StripeTransferSnapshot
} from '../../src/modules/settlements/public.js'
import { closeNotifyAndDebit, count, DEBIT_DAY, driverId, dropSettlementWorldFixtures, later, merchantId, PAYRUN, payouts, resetSettlementWorld, settleDebits, type World } from '../support/settlement-payout-world.js'
import { silentLogger } from '../support/settlement-fakes.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise. Clôture, pré-notification, débits, pay-runs : RÉELS (PostgreSQL) ; Stripe simulé.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const ADMIN = 'aaaaaaaa-0000-4000-8000-0000000000a1'
let release: (() => Promise<void>) | undefined

const runDebits = (world: World, now: Date, sources = world.sources) => new RunSepaDebitsUseCase(new PostgresSepaDebitRepository(pool), sources, world.debits, silentLogger, { syncIntervalSeconds: 900 }).execute({ now })
const sendNotifications = (now: Date, mandate = (m: string): string => `MANDATE-${m.slice(-1)}`) => new SendPreNotificationsUseCase(new PostgresPreNotificationRepository(pool), {
  read: async (m) => ({ email: 'resto@example.test', legalName: 'Resto', activeSepaMethod: { last4: '4242', mandateReference: mandate(m) } })
}, { send: async () => ({ provider: 'resend', messageId: `msg-${randomUUID()}` }) } satisfies EmailSender, { creditorId: 'CREDITOR-TEST', supportEmail: 'support@example.test' }, silentLogger).execute({ now })
const retryUseCase = new RequestDebitRetryUseCase(new PostgresDebitRetryRepository(pool))
const settlementOf = async (n: number): Promise<string> => (await pool.query<{ id: string }>('select id from merchant_settlements where merchant_id = $1::uuid', [merchantId(n)])).rows[0]!.id
const attemptsOf = async (n: number): Promise<Array<Record<string, unknown>>> => (await pool.query(
  `select a.attempt_no, a.status, a.stripe_payment_intent_id as pi, a.stripe_charge_id as charge, ms.status as settlement_status, ms.debit_blocked_reason as blocked
     from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid order by a.attempt_no`, [merchantId(n)])).rows
const statementsOf = async (n: number): Promise<Array<Record<string, unknown>>> => (await pool.query('select due_cents::int as due, paid_cents::int as paid, status, payout_hold_reason as hold from settlement_statements where merchant_id = $1::uuid', [merchantId(n)])).rows

class FakeIncidents implements ChargeIncidentReader {
  public readonly views = new Map<string, ChargeIncidentView | null>()
  public reads = 0
  public async read(chargeId: string): Promise<ChargeIncidentView | null> { this.reads += 1; return this.views.get(chargeId) ?? null }
}
const webhook = (world: World, incidents: FakeIncidents) => {
  const events = new PostgresSettlementEventRepository(pool)
  return {
    events,
    receive: new ReceiveSettlementWebhookUseCase(events, silentLogger),
    process: new ProcessSettlementWebhooksUseCase(events, new PostgresDebitOpsRepository(pool), incidents, async () => undefined, silentLogger)
  }
}
const stripeEvent = (id: string, type: string, object: Record<string, unknown>): { id: string; type: string; account: null; data: { object: Record<string, unknown> } } => ({ id, type, account: null, data: { object } })

beforeAll(async () => { if (isolated) release = await lockSettlementSingleton(pool) })
afterEach(async () => { if (isolated) await resetSettlementWorld() })
afterAll(async () => {
  if (!isolated) return
  await dropSettlementWorldFixtures()
  await release?.()
})

describe.skipIf(!isolated)('settlement operations on PostgreSQL (R70): manual retry', () => {
  it('never retries by itself; a manual retry needs a NEW pre-notification (2 calendar days), the retry attempt is debited only then, and R60 pays the statement through the drip mechanism', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909]])
    await settleDebits(world, { 1: 'failed', 2: 'succeeded' })
    await payouts(world).execute({ now: PAYRUN })
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 0, status: 'unpaid_restaurant' })
    expect((await statementsOf(2))[0]).toMatchObject({ paid: 909, status: 'paid' })

    // Jamais de nouvelle tentative automatique après un véritable échec.
    for (const minutes of [1, 60, 24 * 60, 10 * 24 * 60]) await runDebits(world, later(PAYRUN, minutes))
    expect(await attemptsOf(1)).toHaveLength(1)

    // Relance manuelle : refusée si déjà encaissé ; demandée une fois ; doublon refusé.
    const settlement1 = await settlementOf(1)
    await expect(retryUseCase.execute({ merchantSettlementId: await settlementOf(2), requestedBy: ADMIN, reason: 'x' })).rejects.toMatchObject({ reason: 'debit_already_succeeded' })
    await expect(retryUseCase.execute({ merchantSettlementId: settlement1, requestedBy: ADMIN, reason: '  ' })).rejects.toBeInstanceOf(DebitRetryNotAllowedError)
    const T = new Date('2026-09-14T09:00:00Z') // lundi
    await expect(retryUseCase.execute({ merchantSettlementId: settlement1, requestedBy: ADMIN, reason: 'Le restaurant a régularisé son compte bancaire' })).resolves.toMatchObject({ attemptNo: 2, cause: 'failed_debit' })
    await expect(retryUseCase.execute({ merchantSettlementId: settlement1, requestedBy: ADMIN, reason: 'doublon' })).rejects.toMatchObject({ reason: 'open_retry_request' })

    // La demande ne débite RIEN : sans pré-notification envoyée, ni le worker ni la base ne laissent partir le débit.
    await runDebits(world, later(T, 10 * 24 * 60))
    expect(await attemptsOf(1)).toHaveLength(1)
    await expect(pool.query(
      `insert into debit_attempts(merchant_settlement_id,attempt_no,amount_cents,stripe_account_id,idempotency_key,status,livemode,mandate_reference) values($1::uuid,2,(select amount_cents from merchant_settlements where id = $1::uuid),'acct_fake_1',$2,'creating',false,'MANDATE-1')`,
      [settlement1, `k-${randomUUID()}`])).rejects.toThrow(/pré-notification envoyée pour cette tentative/)

    // Nouvelle pré-notification (envoyée lundi 14 → débit annoncé mercredi 16, jamais avant) : le débit ne part pas la veille.
    await expect(sendNotifications(T)).resolves.toMatchObject({ sent: 1 })
    const notification = (await pool.query("select attempt_no, debit_date::text as debit_date, mandate_reference from settlement_pre_notifications where merchant_settlement_id = $1::uuid and attempt_no = 2", [settlement1])).rows[0]
    expect(notification).toMatchObject({ attempt_no: 2, debit_date: '2026-09-16', mandate_reference: 'MANDATE-1' })
    world.debits.calls.length = 0
    await expect(runDebits(world, new Date('2026-09-16T05:59:00Z'))).resolves.toMatchObject({ due: 0, created: 0 })

    // Changement de mandat entre la pré-notification et le débit : bloqué (nouvelle pré-notification nécessaire).
    world.sources.overrides.set(merchantId(1), { stripeAccountId: 'acct_fake_1', paymentMethodId: 'pm_new', mandateId: 'mandate_new', mandateReference: 'MANDATE-CHANGED' })
    await expect(runDebits(world, new Date('2026-09-16T06:00:00Z'))).resolves.toMatchObject({ due: 1, blocked: 1, created: 0 })
    expect(await attemptsOf(1)).toHaveLength(1)
    world.sources.overrides.delete(merchantId(1))

    // Le mercredi, à 08:00 Paris : la tentative 2 est créée (clé d'idempotence distincte), réussit, et R60 paie le statement en drip.
    await expect(runDebits(world, new Date('2026-09-16T06:01:00Z'))).resolves.toMatchObject({ due: 1, created: 1 })
    const retry = (await attemptsOf(1))[1]!
    expect(retry).toMatchObject({ attempt_no: 2, status: 'processing', settlement_status: 'debit_processing' })
    expect((await statementsOf(1))[0]).toMatchObject({ status: 'waiting_sepa' })
    world.debits.settle(retry.pi as string, 'succeeded')
    await runDebits(world, new Date('2026-09-16T07:00:00Z'))
    expect((await attemptsOf(1))[1]).toMatchObject({ status: 'succeeded', settlement_status: 'succeeded' })
    expect((await statementsOf(1))[0]).toMatchObject({ status: 'succeeded_held', paid: 0 })

    world.transfers.calls.length = 0
    await expect(payouts(world).execute({ now: new Date('2026-09-16T08:00:00Z') })).resolves.toMatchObject({ runsCreated: 1, transferred: 1, transferredCents: 475 })
    expect(world.transfers.calls[0]).toMatchObject({ amountCents: 475, sourceTransactionId: retry.charge }) // la charge de la RELANCE, pas celle de l'échec
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 475, status: 'paid' })
    expect(await count("select count(*) c from driver_pay_runs where run_kind = 'drip'")).toBe(1)
    expect(await count('select count(*) c from driver_transfers')).toBe(2)
  })
})

describe.skipIf(!isolated)('settlement operations on PostgreSQL (R70): webhooks are triggers', () => {
  it('journals a relevant event once (no payload), ignores the rest, and a webhook only WAKES the R50 sync which re-reads Stripe', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    const w = webhook(world, new FakeIncidents())
    const pi = (await attemptsOf(1))[0]!.pi as string
    const event = stripeEvent('evt_1', 'payment_intent.succeeded', { id: pi, latest_charge: 'ch_fake_1' })
    await expect(w.receive.receive(event, later(DEBIT_DAY, 1))).resolves.toBe('recorded')
    await expect(w.receive.receive(event, later(DEBIT_DAY, 1))).resolves.toBe('duplicate') // même événement : jamais deux fois
    await expect(w.receive.receive(stripeEvent('evt_2', 'customer.created', { id: 'cus_1' }))).resolves.toBe('ignored')
    await expect(w.receive.receive(stripeEvent('evt_3', 'payment_intent.succeeded', {}))).resolves.toBe('ignored') // sans identifiant exploitable
    expect(await count('select count(*) c from settlement_stripe_events')).toBe(1)
    expect((await pool.query('select * from settlement_stripe_events')).rows[0]).not.toHaveProperty('payload')

    // Stripe a déjà réussi le débit, mais le suivi R50 n'est dû que dans 15 min : le webhook réveille la relecture.
    world.debits.settle(pi, 'succeeded')
    await runDebits(world, later(DEBIT_DAY, 2))
    expect((await attemptsOf(1))[0]).toMatchObject({ status: 'processing' })
    await expect(w.process.processBatch({ now: later(DEBIT_DAY, 2) })).resolves.toMatchObject({ processed: 1, failed: 0 })
    await runDebits(world, later(DEBIT_DAY, 3))
    expect((await attemptsOf(1))[0]).toMatchObject({ status: 'succeeded' }) // l'état vient de la RELECTURE Stripe, jamais du payload
    expect((await pool.query("select status from settlement_stripe_events where event_id = 'evt_1'")).rows[0]).toMatchObject({ status: 'processed' })
  })

  it('retries an event that precedes the local PaymentIntent record, then dead-letters it visibly; a crashed claim is taken over', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    const w = webhook(world, new FakeIncidents())
    await w.receive.receive(stripeEvent('evt_early', 'payment_intent.processing', { id: 'pi_not_recorded_yet' }), DEBIT_DAY)
    await expect(w.process.processBatch({ now: DEBIT_DAY })).resolves.toMatchObject({ processed: 1, failed: 1 })
    expect((await pool.query("select status, attempt_count, last_error_class from settlement_stripe_events where event_id = 'evt_early'")).rows[0]).toMatchObject({ status: 'pending', attempt_count: 1, last_error_class: 'UnknownSettlementObjectError' })
    await expect(w.process.processBatch({ now: DEBIT_DAY })).resolves.toMatchObject({ processed: 0 }) // backoff
    await pool.query("update settlement_stripe_events set next_attempt_at = $1::timestamptz, attempt_count = 14 where event_id = 'evt_early'", [DEBIT_DAY])
    await w.process.processBatch({ now: later(DEBIT_DAY, 1) })
    expect((await pool.query("select status, attempt_count from settlement_stripe_events where event_id = 'evt_early'")).rows[0]).toMatchObject({ status: 'dead_letter', attempt_count: 15 })

    // Reprise après crash : un worker réserve puis « meurt » ; le bail expire ; un autre traite l'événement.
    const pi = (await attemptsOf(1))[0]!.pi as string
    await w.receive.receive(stripeEvent('evt_crash', 'payment_intent.succeeded', { id: pi }), DEBIT_DAY)
    const stale = await w.events.claimNext({ now: DEBIT_DAY, leaseSeconds: 120 })
    expect(stale?.event.id).toBe('evt_crash')
    await expect(w.process.processBatch({ now: DEBIT_DAY })).resolves.toMatchObject({ processed: 0 }) // bail encore valide
    await pool.query("update settlement_stripe_events set lease_expires_at = now() - interval '1 second' where event_id = 'evt_crash'")
    await expect(w.process.processBatch({ now: DEBIT_DAY })).resolves.toMatchObject({ processed: 1, failed: 0 })
    expect((await pool.query("select status from settlement_stripe_events where event_id = 'evt_crash'")).rows[0]).toMatchObject({ status: 'processed' })
  })
})

describe.skipIf(!isolated)('settlement operations on PostgreSQL (R70): SEPA succeeded then disputed', () => {
  const disputeView = (chargeId: string, over: Partial<ChargeIncidentView> = {}): ChargeIncidentView => ({ chargeId, paymentIntentId: null, chargeAmountCents: 475, amountRefundedCents: 0, dispute: { id: `dp_${chargeId}`, status: 'needs_response', amountCents: 475, reason: 'debit_not_authorized' }, ...over })

  it('AFTER the driver was paid: the restaurant keeps the debt, the driver keeps his money, NO reversal is created (D-A / D-O)', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    await settleDebits(world, { 1: 'succeeded' })
    await payouts(world).execute({ now: PAYRUN })
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 475, status: 'paid' })
    const charge = (await attemptsOf(1))[0]!.charge as string
    const incidents = new FakeIncidents()
    incidents.views.set(charge, disputeView(charge, { dispute: { id: 'dp_1', status: 'lost', amountCents: 475, reason: 'debit_not_authorized' } }))
    const w = webhook(world, incidents)
    await w.receive.receive(stripeEvent('evt_dp', 'charge.dispute.created', { id: 'dp_1', charge, payment_intent: 'pi_x' }), later(PAYRUN, 60))
    await expect(w.process.processBatch({ now: later(PAYRUN, 60) })).resolves.toMatchObject({ processed: 1, failed: 0 })

    expect((await pool.query("select kind, external_id, amount_cents::int as amount, status from debit_incidents")).rows).toEqual([{ kind: 'dispute', external_id: 'dp_1', amount: 475, status: 'lost' }])
    expect((await pool.query("select kind, amount_cents::int as amount, status, stripe_dispute_id from merchant_receivables")).rows).toEqual([{ kind: 'sepa_dispute', amount: 475, status: 'open', stripe_dispute_id: 'dp_1' }]) // dette du RESTAURANT
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 475, status: 'paid' }) // le livreur garde ce qu'il a reçu
    expect(await count('select count(*) c from driver_transfer_reversals')).toBe(0)
    expect(await count('select count(*) c from driver_receivables')).toBe(0) // aucune créance sur le livreur
    expect(await count("select count(*) c from driver_transfers where status = 'succeeded'")).toBe(1)
    // Idempotence : le même incident relu ne crée ni doublon d'incident ni doublon de créance.
    await w.receive.receive(stripeEvent('evt_dp2', 'charge.dispute.updated', { id: 'dp_1', charge }), later(PAYRUN, 61))
    await w.process.processBatch({ now: later(PAYRUN, 61) })
    expect(await count('select count(*) c from debit_incidents')).toBe(1)
    expect(await count('select count(*) c from merchant_receivables')).toBe(1)
  })

  it('BEFORE the driver is paid: no transfer while the charge is contested (DB + Stripe re-check), the statement stays owed by the restaurant; it is paid once the dispute is won', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded' })
    const charge1 = (await attemptsOf(1))[0]!.charge as string
    const incidents = new FakeIncidents()
    incidents.views.set(charge1, disputeView(charge1))
    const w = webhook(world, incidents)
    await w.receive.receive(stripeEvent('evt_dp', 'charge.dispute.created', { id: `dp_${charge1}`, charge: charge1 }), later(PAYRUN, -60))
    await w.process.processBatch({ now: later(PAYRUN, -60) })
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 0, status: 'unpaid_restaurant', hold: 'debit_incident' })

    await expect(payouts(world).execute({ now: PAYRUN })).resolves.toMatchObject({ transferred: 1, transferredCents: 909 }) // seul le restaurant n°2 est payé
    expect(world.transfers.calls.map((c) => c.sourceTransactionId)).not.toContain(charge1)
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 0, status: 'unpaid_restaurant' })
    // Le filet de la base : même un code défectueux ne peut pas créer un Transfer depuis une charge contestée.
    const debit = (await pool.query<{ id: string }>("select id from debit_attempts where stripe_charge_id = $1", [charge1])).rows[0]!.id
    const statement = (await pool.query<{ id: string; period_id: string }>('select id, period_id from settlement_statements where merchant_id = $1::uuid', [merchantId(1)])).rows[0]!
    const run = (await pool.query<{ id: string }>("insert into driver_pay_runs(period_id, driver_id, run_kind, scheduled_for) values($1::uuid, $2::uuid, 'drip', now()) returning id", [statement.period_id, driverId(1)])).rows[0]!.id
    await expect(pool.query("insert into driver_transfers(statement_id, pay_run_id, debit_attempt_id, stripe_charge_id, amount_cents, try_no, idempotency_key, status, livemode) values($1::uuid,$2::uuid,$3::uuid,$4,475,1,$5,'creating',false)", [statement.id, run, debit, charge1, `k-${randomUUID()}`])).rejects.toThrow(/contesté ou remboursé/)
    await pool.query('delete from driver_pay_runs where id = $1::uuid', [run]) // run de test : ne bloque pas le worker

    // Litige GAGNÉ : la charge redevient utilisable, la créance est soldée, R60 paie en drip.
    incidents.views.set(charge1, disputeView(charge1, { dispute: { id: `dp_${charge1}`, status: 'won', amountCents: 475, reason: null } }))
    await w.receive.receive(stripeEvent('evt_dp_won', 'charge.dispute.closed', { id: `dp_${charge1}`, charge: charge1 }), later(PAYRUN, 30))
    await w.process.processBatch({ now: later(PAYRUN, 30) })
    expect((await pool.query('select status from debit_incidents')).rows).toEqual([{ status: 'won' }])
    expect((await pool.query('select status from merchant_receivables')).rows).toEqual([{ status: 'recovered' }])
    await expect(payouts(world).execute({ now: later(PAYRUN, 60) })).resolves.toMatchObject({ transferred: 1, transferredCents: 475 })
    expect((await statementsOf(1))[0]).toMatchObject({ paid: 475, status: 'paid' })
  })

  it('a refund is a restaurant incident too; stale/out-of-order events cannot regress state because Stripe is re-read each time', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    await settleDebits(world, { 1: 'succeeded' })
    const charge = (await attemptsOf(1))[0]!.charge as string
    const incidents = new FakeIncidents()
    const w = webhook(world, incidents)
    // Le litige a été GAGNÉ puis remboursement partiel : les deux événements arrivent dans le désordre, l'état courant Stripe est unique.
    incidents.views.set(charge, disputeView(charge, { amountRefundedCents: 100, dispute: { id: 'dp_2', status: 'won', amountCents: 475, reason: null } }))
    await w.receive.receive(stripeEvent('evt_new', 'charge.dispute.closed', { id: 'dp_2', charge }), later(PAYRUN, 5))
    await w.receive.receive(stripeEvent('evt_old', 'charge.dispute.created', { id: 'dp_2', charge }), later(PAYRUN, 5))
    await w.receive.receive(stripeEvent('evt_ref', 'charge.refunded', { id: charge, payment_intent: 'pi_x' }), later(PAYRUN, 5))
    await expect(w.process.processBatch({ now: later(PAYRUN, 5) })).resolves.toMatchObject({ processed: 3, failed: 0 })
    expect((await pool.query('select kind, status, amount_cents::int as amount from debit_incidents order by kind')).rows).toEqual([{ kind: 'dispute', status: 'won', amount: 475 }, { kind: 'refund', status: 'lost', amount: 100 }])
    expect((await pool.query('select kind, status, amount_cents::int as amount from merchant_receivables order by kind')).rows).toEqual([{ kind: 'sepa_dispute', status: 'recovered', amount: 475 }, { kind: 'sepa_refund', status: 'open', amount: 100 }])
    expect((await statementsOf(1))[0]).toMatchObject({ status: 'unpaid_restaurant', hold: 'debit_incident' }) // remboursé : la charge ne finance plus rien
  })
})

describe.skipIf(!isolated)('settlement operations on PostgreSQL (R70): DB <-> Stripe reconciliation', () => {
  class FakeReader implements ReconciliationStripeReader {
    public debits = new Map<string, StripeDebitSnapshot | null>()
    public transfers = new Map<string, StripeTransferSnapshot | null>()
    public refunds = new Map<string, { refundId: string; chargeId: string; amountCents: number; currency: string; status: string } | null>()
    public recent: Array<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null }> = []
    public balances = new Map<string, { availableCents: number; pendingCents: number }>()
    public payouts = new Map<string, Array<{ payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null }>>()
    public failDebitFor: string | null = null
    public async readDebit(pi: string): Promise<StripeDebitSnapshot | null> { if (pi === this.failDebitFor) throw new Error('boom'); return this.debits.get(pi) ?? null }
    public async readTransfer(id: string): Promise<StripeTransferSnapshot | null> { return this.transfers.get(id) ?? null }
    public async readRefund(id: string): Promise<{ refundId: string; chargeId: string; amountCents: number; currency: string; status: string } | null> { return this.refunds.get(id) ?? null }
    public async readTransferOrigin(id: string): Promise<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null } | null> { return this.recent.find((t) => t.transferId === id) ?? null }
    public async listRecentTransfers(): Promise<Array<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null }>> { return this.recent }
    public async readDriverBalance(account: string): Promise<{ availableCents: number; pendingCents: number } | null> { return this.balances.get(account) ?? { availableCents: 0, pendingCents: 0 } }
    public async listPayouts(account: string): Promise<Array<{ payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null }>> { return this.payouts.get(account) ?? [] }
  }

  async function paidWorld(): Promise<{ world: World; reader: FakeReader; reconcile: RunSettlementReconciliationUseCase }> {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded' })
    await payouts(world).execute({ now: PAYRUN })
    const reader = new FakeReader()
    for (const [pi, obs] of world.debits.intents) reader.debits.set(pi, { paymentIntentId: pi, paymentIntentStatus: obs.paymentIntentStatus, chargeId: obs.chargeId, chargeStatus: obs.chargeStatus, paid: obs.paid, hasBalanceTransaction: obs.hasBalanceTransaction, amountCents: obs.amountCents, currency: 'eur', livemode: false, disputed: false, amountRefundedCents: 0 })
    for (const t of world.transfers.created) reader.transfers.set(t.transferId, { transferId: t.transferId, amountCents: t.amountCents, currency: 'eur', destinationAccountId: t.destinationAccountId, sourceTransactionId: t.sourceTransactionId, amountReversedCents: 0, livemode: false })
    reader.recent = (await pool.query<{ id: string; stripe: string; amount: string }>("select id, stripe_transfer_id as stripe, amount_cents::text as amount from driver_transfers where status = 'succeeded'")).rows.map((r) => ({ transferId: r.stripe, amountCents: Number(r.amount), driverTransferIdMetadata: r.id }))
    return { world, reader, reconcile: new RunSettlementReconciliationUseCase(new PostgresReconciliationRepository(pool), reader, silentLogger) }
  }
  const openFindings = async (): Promise<Array<Record<string, unknown>>> => (await pool.query('select kind, scope, ref_type, expected_cents::int as expected, actual_cents::int as actual from settlement_reconciliation_findings where resolved_at is null order by kind, ref_id')).rows

  it('finds nothing when the database and Stripe agree, and records payout observations', async () => {
    const { reader, reconcile } = await paidWorld()
    reader.payouts.set('acct_driver_1', [{ payoutId: 'po_1', amountCents: 1108, status: 'paid', automatic: true, arrivalDate: '2026-09-15' }])
    const summary = await reconcile.execute({ now: later(PAYRUN, 24 * 60) })
    expect(summary).toMatchObject({ readErrors: 0, opened: 0, restaurantFindings: 0, technicalFindings: 0, payoutsObserved: 1 })
    expect(summary.checked).toBeGreaterThanOrEqual(5)
    expect(await openFindings()).toEqual([])
    expect((await pool.query("select status, discrepancy_count from settlement_reconciliation_runs")).rows).toEqual([{ status: 'completed', discrepancy_count: 0 }])
    expect((await pool.query('select stripe_payout_id, amount_cents::int as amount, status from driver_payout_observations')).rows).toEqual([{ stripe_payout_id: 'po_1', amount: 1108, status: 'paid' }])
  })

  it('separates RESTAURANT incidents from Locadely TECHNICAL discrepancies, never mixes them, dedupes, and resolves a finding that no longer reproduces', async () => {
    const { world, reader, reconcile } = await paidWorld()
    const [debit1] = (await pool.query<{ pi: string }>('select stripe_payment_intent_id as pi from debit_attempts order by amount_cents')).rows.map((r) => r.pi)
    reader.debits.set(debit1!, { ...reader.debits.get(debit1!)!, disputed: true }) // restaurant : contesté après succès
    const transfer = world.transfers.created[0]!
    reader.transfers.set(transfer.transferId, { ...reader.transfers.get(transfer.transferId)!, amountCents: transfer.amountCents + 1, amountReversedCents: 5 }) // technique : montant + reversal inconnue
    reader.recent.push({ transferId: 'tr_orphan', amountCents: 999, driverTransferIdMetadata: null }) // technique : Transfer Stripe orphelin
    reader.balances.set('acct_driver_1', { availableCents: -300, pendingCents: 0 }) // technique : solde négatif
    const first = await reconcile.execute({ now: later(PAYRUN, 24 * 60) })
    expect(first).toMatchObject({ restaurantFindings: 1, technicalFindings: 4, opened: 5 })
    const findings = await openFindings()
    expect(findings.filter((f) => f.scope === 'restaurant').map((f) => f.kind)).toEqual(['debit_disputed_after_success'])
    expect(findings.filter((f) => f.scope === 'locadely_technical').map((f) => f.kind).sort()).toEqual(['driver_negative_balance', 'stripe_transfer_orphan', 'transfer_amount_mismatch', 'transfer_reversal_ledger_mismatch'])
    expect(findings.some((f) => f.kind === 'debit_disputed_after_success' && f.scope !== 'restaurant')).toBe(false)

    // Deuxième passage identique : aucun doublon (un seul constat ouvert par objet et par kind).
    const second = await reconcile.execute({ now: later(PAYRUN, 48 * 60) })
    expect(second).toMatchObject({ opened: 0, stillOpen: 5 })
    expect(await openFindings()).toHaveLength(5)

    // Un objet illisible n'est PAS déclaré examiné : son constat n'est pas résolu à tort. Un constat qui ne se reproduit plus est résolu.
    reader.failDebitFor = debit1!
    reader.debits.set(debit1!, { ...reader.debits.get(debit1!)!, disputed: false })
    reader.balances.set('acct_driver_1', { availableCents: 0, pendingCents: 0 })
    const third = await reconcile.execute({ now: later(PAYRUN, 72 * 60) })
    expect(third).toMatchObject({ readErrors: 1, resolved: 1 })
    const kinds = (await openFindings()).map((f) => f.kind)
    expect(kinds).toContain('debit_disputed_after_success') // illisible : conservé
    expect(kinds).not.toContain('driver_negative_balance') // résolu
  })

  it('a webhook audit of one Transfer records technical findings without creating a daily run', async () => {
    const { world, reader, reconcile } = await paidWorld()
    const transfer = world.transfers.created[0]!
    reader.transfers.set(transfer.transferId, { ...reader.transfers.get(transfer.transferId)!, amountReversedCents: 50 })
    await reconcile.auditTransfer(transfer.transferId, later(PAYRUN, 5))
    expect(await openFindings()).toMatchObject([{ kind: 'transfer_reversal_ledger_mismatch', scope: 'locadely_technical', expected: 0, actual: 50 }])
    expect(await count('select count(*) c from settlement_reconciliation_runs')).toBe(0)
  })
})
