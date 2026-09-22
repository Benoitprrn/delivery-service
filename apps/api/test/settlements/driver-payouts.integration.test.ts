import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresDriverPayoutRepository, TransferRejectedError, TransferTransientError, type DriverPayoutRepository } from '../../src/modules/settlements/public.js'
import { closeNotifyAndDebit, count, driverId, dropSettlementWorldFixtures, later, merchantId, PAYRUN, payouts, resetSettlementWorld, settleDebits } from '../support/settlement-payout-world.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise. Voir `support/settlement-payout-world.ts` (monde partagé avec R61).
// Calendrier : clôture lun 2026-08-31 00:05 Paris ; débits mer 2026-09-02 08:00 Paris ; payrun_at = ven 2026-09-11 10:00 Paris = 08:00Z.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
let release: (() => Promise<void>) | undefined

const statements = async (driver: number): Promise<Array<Record<string, unknown>>> => (await pool.query(
  `select m.name, st.due_cents::int as due, st.paid_cents::int as paid, st.status, st.payout_hold_reason as hold from settlement_statements st join merchants m on m.id = st.merchant_id where st.driver_id = $1::uuid order by m.name`, [driverId(driver)])).rows
const transfersDb = async (): Promise<Array<Record<string, unknown>>> => (await pool.query(
  `select m.name, t.status, t.amount_cents::int as amount, t.try_no, t.idempotency_key, t.stripe_charge_id, t.stripe_transfer_id, t.failure_code, t.destination_account_id, t.pay_run_id, r.run_kind
     from driver_transfers t join settlement_statements st on st.id = t.statement_id join merchants m on m.id = st.merchant_id join driver_pay_runs r on r.id = t.pay_run_id order by m.name, t.try_no`)).rows
const names = (n: number): string => `Resto d1-${n}`

beforeAll(async () => {
  if (!isolated) return
  release = await lockSettlementSingleton(pool)
})
afterEach(async () => { if (isolated) await resetSettlementWorld() })
afterAll(async () => {
  if (!isolated) return
  await dropSettlementWorldFixtures()
  await release?.()
})

describe.skipIf(!isolated)('driver pay-runs on PostgreSQL (R60, D-M / D-N / D-O)', () => {
  it('1 driver x 10 restaurants: the grouped pay-run pays only the 8 really succeeded statements, then drip-pays the late one and the regularised one', async () => {
    const rows = Array.from({ length: 10 }, (_, i): [number, number, 475] => [i + 1, 1, 475]) // 10 statements de 380 c (gain 475 - frais 95)
    const world = await closeNotifyAndDebit(rows)
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded', 3: 'succeeded', 4: 'succeeded', 5: 'succeeded', 6: 'succeeded', 7: 'succeeded', 8: 'succeeded', 9: 'failed' }) // n°10 reste `processing`
    const run = payouts(world)

    // Avant payrun_at : aucun Transfer, aucun contrôle Stripe, aucun pay-run.
    await expect(run.execute({ now: new Date(PAYRUN.getTime() - 60_000) })).resolves.toMatchObject({ runsCreated: 0, transferred: 0 })
    expect(world.transfers.calls).toHaveLength(0)
    expect(await count('select count(*) c from driver_pay_runs')).toBe(0)

    // Pay-run GROUPÉ à payrun_at.
    const rechecksBefore = world.debits.retrievals
    await expect(run.execute({ now: PAYRUN })).resolves.toMatchObject({ runsCreated: 1, runsProcessed: 1, statements: 10, transferred: 8, transferredCents: 3040, waiting: 2, errors: 0 })
    expect(world.transfers.calls).toHaveLength(8)
    expect(world.debits.retrievals - rechecksBefore).toBe(8) // un contrôle Stripe de la charge AVANT CHAQUE Transfer
    for (const call of world.transfers.calls) {
      expect(call.amountCents).toBe(380)
      expect(call.destinationAccountId).toBe('acct_driver_1')
      expect(call.sourceTransactionId).toMatch(/^ch_fake_/) // source_transaction = charge du restaurant
      expect(call.idempotencyKey).toMatch(/^stmt:[0-9a-f-]+:charge:ch_fake_\d+:try:1$/)
      expect(call.metadata.funding_mode).toBe('source_transaction')
    }
    const byName = (a: unknown[], b: unknown[]): number => String(a[0]).localeCompare(String(b[0]))
    expect((await transfersDb()).map((t) => [t.name, t.status, t.amount, t.run_kind]).sort(byName)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [names(n), 'succeeded', 380, 'grouped']).sort(byName))
    const first = await statements(1)
    expect(first.filter((s) => s.status === 'paid')).toHaveLength(8)
    expect(first.find((s) => s.name === names(9))).toMatchObject({ paid: 0, status: 'unpaid_restaurant' }) // impayé : rien envoyé, rattaché au restaurant
    expect(first.find((s) => s.name === names(10))).toMatchObject({ paid: 0, status: 'waiting_sepa' }) // en retard : en attente
    expect(await count("select count(*) c from driver_pay_runs where run_kind = 'grouped' and status = 'completed' and statements_total = 10 and statements_paid = 8 and amount_cents = 3040")).toBe(1)

    // Rien de nouveau : pas de second Transfer, pas de pay-run drip inutile.
    world.transfers.calls.length = 0
    await expect(run.execute({ now: later(PAYRUN, 5) })).resolves.toMatchObject({ runsCreated: 0, transferred: 0 })
    expect(world.transfers.calls).toHaveLength(0)

    // Le restaurant n°10 (en retard) finit par réussir : payé au compte-gouttes, sans attendre.
    await settleDebits(world, { 10: 'succeeded' }, later(PAYRUN, 20))
    await expect(run.execute({ now: later(PAYRUN, 40) })).resolves.toMatchObject({ runsCreated: 1, transferred: 1, transferredCents: 380 })
    expect((await statements(1)).find((s) => s.name === names(10))).toMatchObject({ paid: 380, status: 'paid' })

    // Le restaurant n°9 régularise (nouveau débit réussi) : payé à son tour, seul son reliquat.
    const settlement9 = (await pool.query<{ id: string; amount: string }>('select id, amount_cents::text as amount from merchant_settlements where merchant_id = $1::uuid', [merchantId(9)])).rows[0]!
    // Une régularisation exige sa propre pré-notification (tentative 2), envoyée ≥ 2 jours avant.
    await pool.query(
      `insert into settlement_pre_notifications(merchant_settlement_id,amount_cents,attempt_no,requested_by,retry_reason,status,attempt_count,recipient_email,debit_date,iban_last4,mandate_reference,creditor_id,provider,provider_message_id,sent_at)
       values($1::uuid,$2::bigint,2,$3::uuid,'régularisation','sent',1,'m@example.test','2026-09-09','4242','MANDATE-9','CREDITOR-TEST','resend','msg-regularised','2026-09-07T09:00:00Z')`, [settlement9.id, settlement9.amount, 'aaaaaaaa-0000-4000-8000-0000000000a1'])
    await pool.query(
      `insert into debit_attempts(merchant_settlement_id,attempt_no,amount_cents,stripe_account_id,stripe_payment_intent_id,stripe_charge_id,idempotency_key,status,succeeded_at,livemode,mandate_reference)
       values($1::uuid,2,$2::bigint,'acct_fake_9','pi_regularised','ch_regularised',$3,'succeeded',now(),false,'MANDATE-9')`, [settlement9.id, settlement9.amount, `debit:${settlement9.id}:attempt:2`])
    world.debits.intents.set('pi_regularised', { paymentIntentId: 'pi_regularised', paymentIntentStatus: 'succeeded', amountCents: Number(settlement9.amount), currency: 'eur', livemode: false, attemptIdMetadata: null, chargeId: 'ch_regularised', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, availableOn: null, failureCode: null })
    world.transfers.calls.length = 0
    await expect(run.execute({ now: later(PAYRUN, 60) })).resolves.toMatchObject({ transferred: 1, transferredCents: 380 })
    expect(world.transfers.calls).toMatchObject([{ amountCents: 380, sourceTransactionId: 'ch_regularised' }])
    expect((await statements(1)).every((s) => s.paid === 380 && s.status === 'paid')).toBe(true)
    expect(await count("select count(*) c from driver_transfers where status = 'succeeded'")).toBe(10)
    expect(await count("select coalesce(sum(amount_cents),0) c from driver_transfers where status = 'succeeded'")).toBe(3800)
    expect(await count("select count(*) c from driver_pay_runs where run_kind = 'grouped'")).toBe(1)
    expect(await count("select count(*) c from driver_pay_runs where run_kind = 'drip'")).toBe(2)
  })

  it('never trusts the recorded debit alone: Stripe says failed / mismatching / technical => no transfer, and no restaurant is wrongly marked unpaid on a technical state', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 475], [3, 1, 475]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded', 3: 'succeeded' })
    // n°1 : Stripe dit maintenant « failed » (retour SEPA) ; n°2 : montant Stripe différent ; n°3 : débit local en erreur technique.
    const pis = (await pool.query<{ name: string; pi: string; id: string }>('select m.name, a.stripe_payment_intent_id as pi, a.id from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id join merchants m on m.id = ms.merchant_id order by m.name')).rows
    world.debits.settle(pis[0]!.pi, 'failed')
    world.debits.intents.set(pis[1]!.pi, { ...world.debits.intents.get(pis[1]!.pi)!, amountCents: 1 })
    await pool.query("update debit_attempts set status = 'technical_error', technical_error_at = now(), failure_code = 'technical:test' where id = $1", [pis[2]!.id])
    await pool.query("update merchant_settlements set status = 'technical_hold' where merchant_id = $1::uuid", [merchantId(3)])

    await expect(payouts(world).execute({ now: PAYRUN })).resolves.toMatchObject({ transferred: 0, waiting: 3 })
    expect(world.transfers.calls).toHaveLength(0)
    expect(await statements(1)).toMatchObject([
      { name: names(1), paid: 0, status: 'unpaid_restaurant', hold: 'debit_recheck_failed' },
      { name: names(2), paid: 0, hold: 'debit_recheck_mismatch' },
      { name: names(3), paid: 0, status: 'waiting_sepa', hold: 'debit_technical_error' }
    ])
  })

  it('never pays a driver whose Stripe account is not ready (local or live), never blocks other drivers, then pays once the account is ready', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 475], [1, 2, 909], [2, 2, 909]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded' })
    world.accounts.notReady.add('acct_driver_1') // restreint chez Stripe
    const run = payouts(world)
    await expect(run.execute({ now: PAYRUN })).resolves.toMatchObject({ runsCreated: 2, transferred: 2, waiting: 2 })
    expect(world.transfers.calls.every((c) => c.destinationAccountId === 'acct_driver_2')).toBe(true) // livreur 2 payé, indépendant du livreur 1
    expect((await statements(1)).map((s) => [s.paid, s.status, s.hold])).toEqual([[0, 'blocked_driver_account', 'blocked_driver_account'], [0, 'blocked_driver_account', 'blocked_driver_account']])
    expect((await statements(2)).every((s) => s.status === 'paid')).toBe(true)

    // Restreint aussi côté local (webhook R30) : même refus, sans relire Stripe.
    await pool.query("update driver_connect_accounts set transfers_status = 'restricted', restricted_at = now() where driver_id = $1::uuid", [driverId(1)])
    world.accounts.notReady.delete('acct_driver_1')
    world.transfers.calls.length = 0
    await run.execute({ now: later(PAYRUN, 30) })
    expect(world.transfers.calls).toHaveLength(0)

    // Régularisé : le dû, resté acquis, est payé.
    await pool.query("update driver_connect_accounts set transfers_status = 'active', restricted_at = null where driver_id = $1::uuid", [driverId(1)])
    await expect(run.execute({ now: later(PAYRUN, 60) })).resolves.toMatchObject({ transferred: 2 })
    expect((await statements(1)).every((s) => s.status === 'paid')).toBe(true)
  })

  it('handles Stripe transfer failures per statement: definitive rejection (retry with try 2, capability => blocked), unknown result (same key), crash after Stripe (adopts, no duplicate)', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 475], [3, 1, 475], [4, 1, 475]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded', 3: 'succeeded', 4: 'succeeded' })
    const stmt = async (n: number): Promise<string> => (await pool.query<{ id: string }>('select id from settlement_statements where merchant_id = $1::uuid', [merchantId(n)])).rows[0]!.id
    world.transfers.errorsOnce.set(await stmt(1), new TransferRejectedError('parameter_invalid', false))
    world.transfers.errorsOnce.set(await stmt(2), new TransferRejectedError('insufficient_capabilities_for_transfer', true))
    const stmt3 = await stmt(3)
    world.transfers.errorsOnce.set(stmt3, new TransferTransientError('api_connection_error'))
    let crashed = false
    const crashStatement = await stmt(4)
    const crashy: DriverPayoutRepository = new Proxy(new PostgresDriverPayoutRepository(pool), {
      get(target, property, receiver) {
        if (property === 'completeTransfer') return async (input: Parameters<DriverPayoutRepository['completeTransfer']>[0]) => {
          const owner = (await pool.query<{ statement_id: string }>('select statement_id from driver_transfers where id = $1', [input.transferId])).rows[0]?.statement_id
          if (!crashed && owner === crashStatement) { crashed = true; throw new Error('simulated crash after Stripe created the transfer') }
          return target.completeTransfer(input)
        }
        return Reflect.get(target, property, receiver) as unknown
      }
    })
    const run = payouts(world, crashy)
    const first = await run.execute({ now: PAYRUN })
    expect(first).toMatchObject({ transferred: 0, rejected: 2, unknown: 1, errors: 1 }) // n°4 : crash après Stripe, isolé des autres
    // Une erreur de Stripe n'est jamais une faute du restaurant : aucun statement « unpaid_restaurant ».
    expect(await count("select count(*) c from settlement_statements where status = 'unpaid_restaurant'")).toBe(0)
    const afterFirst = await statements(1)
    expect(afterFirst.find((s) => s.name === names(1))).toMatchObject({ paid: 0, hold: 'transfer_rejected:parameter_invalid' })
    expect(afterFirst.find((s) => s.name === names(2))).toMatchObject({ paid: 0, status: 'blocked_driver_account' })

    // Cycles suivants : n°3 rejoué avec la MÊME clé ; n°4 (crash après Stripe) retrouvé chez Stripe, adopté sans second Transfer ; n°1/n°2 après le délai (essai 2).
    await run.execute({ now: later(PAYRUN, 5) })
    await run.execute({ now: later(PAYRUN, 90) })
    const rows = await transfersDb()
    expect(rows.filter((t) => t.name === names(3)).map((t) => [t.status, t.try_no])).toEqual([['succeeded', 1]])
    expect(rows.filter((t) => t.name === names(1)).map((t) => [t.status, t.try_no, t.failure_code])).toEqual([['failed', 1, 'parameter_invalid'], ['succeeded', 2, null]])
    expect(new Set(rows.filter((t) => t.name === names(1)).map((t) => t.idempotency_key)).size).toBe(2) // essai 2 = nouvelle clé, seulement après un 4xx définitif
    const key3 = world.transfers.calls.filter((c) => c.metadata.statement_id === stmt3)
    expect(key3.length).toBeGreaterThanOrEqual(2) // 1 essai « inconnu » puis rejeu
    expect(new Set(key3.map((c) => c.idempotencyKey)).size).toBe(1) // toujours la MÊME clé
    expect(rows.filter((t) => t.name === names(4)).map((t) => t.status)).toEqual(['succeeded'])
    expect(world.transfers.created).toHaveLength(4) // exactement un Transfer Stripe par statement, jamais de doublon
    expect((await statements(1)).every((s) => s.paid === 380 && s.status === 'paid')).toBe(true)
  })

  it('runs concurrent workers safely (one Transfer per statement) and annotates the destination payment without ever blocking the payment', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909]])
    await settleDebits(world, { 1: 'succeeded', 2: 'succeeded' })
    world.transfers.annotateFails = true
    await Promise.all([1, 2, 3].map(() => payouts(world).execute({ now: PAYRUN })))
    expect(world.transfers.created).toHaveLength(2)
    expect(await count("select count(*) c from driver_transfers where status = 'succeeded'")).toBe(2)
    expect((await statements(1)).every((s) => s.status === 'paid')).toBe(true)
    expect(await count('select count(*) c from driver_transfers where annotated_at is not null')).toBe(0) // annotation en échec : le paiement reste valide

    world.transfers.annotateFails = false
    await payouts(world).execute({ now: later(PAYRUN, 10) })
    expect(world.transfers.annotations).toHaveLength(2)
    expect(world.transfers.annotations[0]!.description).toContain('du 2026-08-24 au 2026-08-30')
    expect(await count('select count(*) c from driver_transfers where annotated_at is not null')).toBe(2)
    expect(await count('select count(*) c from driver_pay_runs where run_kind = \'grouped\'')).toBe(1)
  })

  it('the database refuses a transfer to an account that is not the ACTIVE account of the statement driver', async () => {
    const world = await closeNotifyAndDebit([[1, 1, 475]])
    await settleDebits(world, { 1: 'succeeded' })
    await pool.query("update driver_connect_accounts set transfers_status = 'restricted' where driver_id = $1::uuid", [driverId(1)])
    const debit = (await pool.query<{ id: string; charge: string }>("select a.id, a.stripe_charge_id as charge from debit_attempts a where a.status = 'succeeded'")).rows[0]!
    const st = (await pool.query<{ id: string; period_id: string }>('select id, period_id from settlement_statements')).rows[0]!
    const runId = (await pool.query<{ id: string }>("insert into driver_pay_runs(period_id, driver_id, run_kind, scheduled_for) values($1::uuid, $2::uuid, 'drip', now()) returning id", [st.period_id, driverId(1)])).rows[0]!.id
    const insert = (destination: string): Promise<unknown> => pool.query(
      `insert into driver_transfers(statement_id, pay_run_id, debit_attempt_id, stripe_charge_id, destination_account_id, amount_cents, try_no, idempotency_key, status, livemode) values($1::uuid,$2::uuid,$3::uuid,$4,$5,380,1,$6,'creating',false)`,
      [st.id, runId, debit.id, debit.charge, destination, `k-${randomUUID()}`])
    await expect(insert('acct_driver_1')).rejects.toThrow(/compte Stripe ACTIF/) // compte restreint
    await pool.query("update driver_connect_accounts set transfers_status = 'active' where driver_id = $1::uuid", [driverId(1)])
    await expect(insert('acct_someone_else')).rejects.toThrow(/compte Stripe ACTIF/) // compte d'un autre
    await expect(insert('acct_driver_1')).resolves.toBeDefined()
  })
})
