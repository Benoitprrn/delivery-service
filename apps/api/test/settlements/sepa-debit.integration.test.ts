import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresOrderRepository } from '../../src/modules/orders/infrastructure/postgres-order-repository.js'
import {
  CloseSettlementPeriodUseCase, PostgresPreNotificationRepository, PostgresSepaDebitRepository, PostgresSettlementCloseRepository, RunSepaDebitsUseCase, SendPreNotificationsUseCase, SepaDebitRejectedError, SepaDebitTechnicalError, SepaDebitTransientError,
  type DebitSourceReader, type EmailSender, type SepaDebitRepository, type SettlementLogger
} from '../../src/modules/settlements/public.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { FakeProvider, FakeSources } from '../support/settlement-fakes.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise (`source docs/work/r10-testdb.sh`). Les règlements viennent de la vraie clôture R40 et de la vraie pré-notification R41 ;
// seul Stripe est simulé. Monday close = 2026-08-31 00:05 Paris ; debit_date annoncée = mercredi 2026-09-02 ; le prélèvement démarre à 08:00 Paris = 06:00Z.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const zoneId = '11111111-1111-1111-1111-111111111111'
const merchant1 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'
const merchant2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2'
const driver1 = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
const driver2 = 'ffffffff-ffff-ffff-ffff-fffffffffff2'
const CLOSE_NOW = new Date('2026-08-30T22:05:00.000Z')
const DEBIT_DAY = new Date('2026-09-02T06:00:00.000Z')
const orderIds: string[] = []
const SHAPE: Record<number, [number, number]> = { 401: [5000, 317], 475: [3000, 720], 909: [7000, 1500] }
const silent: SettlementLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const debitRepository = new PostgresSepaDebitRepository(pool)
let release: (() => Promise<void>) | undefined

async function setGoLive(value: string | null): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('alter table settlement_settings disable trigger settlement_settings_guard')
    await client.query('update settlement_settings set go_live_at = $1::timestamptz where id = true', [value])
    await client.query('alter table settlement_settings enable trigger settlement_settings_guard')
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function order(merchant: string, driver: string, earning: 401 | 475 | 909, completedAt: string): Promise<void> {
  const id = randomUUID()
  const shape = SHAPE[earning]!
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'COMPLETED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,$5::int,$6::int,$7::int,'2026-08-24 08:00:00+00',$8::timestamptz)`,
    [id, merchant, driver, zoneId, shape[0], shape[1], earning, completedAt])
  await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, earning, Math.floor((earning * 2_000) / 10_000)])
  orderIds.push(id)
}

/** Restaurant 1 : 475 + 95 + 909 + 181 = 1660 c ; restaurant 2 : 401 + 80 = 481 c. */
async function closeAndNotify(opts: { notify?: boolean; notifyAt?: Date; mandates?: Record<string, string> } = {}): Promise<void> {
  await setGoLive('2026-08-15T00:00:00Z')
  await order(merchant1, driver1, 475, '2026-08-25 10:00:00+00')
  await order(merchant1, driver2, 909, '2026-08-26 11:00:00+00')
  await order(merchant2, driver1, 401, '2026-08-27 09:00:00+00')
  await new CloseSettlementPeriodUseCase(new PostgresSettlementCloseRepository(pool), new PostgresOrderRepository(pool)).execute({ now: CLOSE_NOW })
  if (opts.notify === false) return
  const sender: EmailSender = { send: async () => ({ provider: 'resend', messageId: `msg-${randomUUID()}` }) }
  await new SendPreNotificationsUseCase(new PostgresPreNotificationRepository(pool), {
    read: async (merchantId) => ({ email: 'resto@example.test', legalName: 'Resto', activeSepaMethod: { last4: '4242', mandateReference: opts.mandates?.[merchantId] ?? `MANDATE-${merchantId.slice(-1)}` } })
  }, sender, { creditorId: 'CREDITOR-TEST', supportEmail: 'support@example.test' }, silent).execute({ now: opts.notifyAt ?? CLOSE_NOW })
}

function runner(provider: FakeProvider, sources: DebitSourceReader, repository: SepaDebitRepository = debitRepository): RunSepaDebitsUseCase {
  return new RunSepaDebitsUseCase(repository, sources, provider, silent, { syncIntervalSeconds: 900, retryDelaySeconds: 60 })
}
const count = async (sql: string): Promise<number> => Number((await pool.query<{ c: string }>(sql)).rows[0]?.c)
const attempts = async (): Promise<Array<Record<string, unknown>>> => (await pool.query(
  `select ms.merchant_id, a.status, a.attempt_no, a.amount_cents::int as amount, a.stripe_payment_intent_id, a.stripe_charge_id, a.failure_code, a.mandate_reference, a.stripe_payment_method_id, a.stripe_mandate_id,
          a.idempotency_key, a.sync_error_class, a.available_on, a.succeeded_at, a.pre_notification_id is not null as linked, ms.id as settlement_id, ms.status as settlement_status, ms.debit_blocked_reason
     from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id order by ms.merchant_id`)).rows
const settlements = async (): Promise<Array<Record<string, unknown>>> => (await pool.query(
  `select merchant_id, status, debit_blocked_reason, amount_cents::int as amount, id from merchant_settlements where amount_cents > 0 order by merchant_id`)).rows
const statementStatuses = async (merchantId: string): Promise<string[]> => (await pool.query<{ status: string }>('select status from settlement_statements where merchant_id = $1::uuid order by driver_id', [merchantId])).rows.map((r) => r.status)
const later = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * 60_000)

beforeAll(async () => {
  if (!isolated) return
  release = await lockSettlementSingleton(pool)
  for (const [id, name] of [[merchant1, 'Resto e1'], [merchant2, 'Resto e2']] as const) await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [id, name, zoneId])
  for (const [id, name] of [[driver1, 'Livreur f1'], [driver2, 'Livreur f2']] as const) await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [id, name, zoneId])
})
afterEach(async () => {
  if (!isolated) return
  await pool.query('truncate table settlement_lines, settlement_statements, merchant_settlements, settlement_periods cascade')
  await deleteTestOrders(pool, orderIds.splice(0))
  await setGoLive(null)
})
afterAll(async () => {
  if (!isolated) return
  await pool.query('delete from drivers where id = any($1::uuid[])', [[driver1, driver2]])
  await pool.query('delete from merchants where id = any($1::uuid[])', [[merchant1, merchant2]])
  await release?.()
})

describe.skipIf(!isolated)('SEPA debit execution on PostgreSQL (R50)', () => {
  it('debits each notified restaurant ONCE, only from the announced date at 08:00 Paris, for the frozen amount, and ignores 0 € settlements', async () => {
    await closeAndNotify()
    // Un règlement à 0 € « notifié » dans une période vide : jamais débité.
    const emptyPeriod = (await pool.query<{ id: string }>("select id from settlement_periods where period_start = '2026-08-16T22:00:00Z'")).rows[0]!.id
    await pool.query("insert into merchant_settlements(period_id, merchant_id, amount_cents, driver_amount_cents, service_fee_cents, status) values($1::uuid, $2::uuid, 0, 0, 0, 'notified')", [emptyPeriod, merchant1])
    const provider = new FakeProvider()
    const run = runner(provider, new FakeSources())

    await expect(run.execute({ now: new Date('2026-09-01T12:00:00Z') })).resolves.toMatchObject({ due: 0, created: 0 }) // la veille
    await expect(run.execute({ now: new Date('2026-09-02T05:59:59Z') })).resolves.toMatchObject({ due: 0, created: 0 }) // 07:59:59 Paris
    expect(provider.calls).toHaveLength(0)

    await expect(run.execute({ now: DEBIT_DAY })).resolves.toMatchObject({ due: 2, created: 2, errors: 0 })
    const frozen = await settlements()
    expect(provider.calls.map((c) => [c.metadata.merchant_id, c.amountCents]).sort()).toEqual([[merchant1, 1660], [merchant2, 481]])
    for (const call of provider.calls) {
      const settlement = frozen.find((s) => s.merchant_id === call.metadata.merchant_id)!
      expect(call.amountCents).toBe(settlement.amount) // montant = règlement figé
      expect(call.idempotencyKey).toBe(`debit:${settlement.id}:attempt:1`)
      expect(call.metadata).toMatchObject({ merchant_settlement_id: settlement.id })
      expect(call.transferGroup).toBe(`settlement:${settlement.id}`)
    }
    expect(await attempts()).toMatchObject([
      { merchant_id: merchant1, status: 'processing', attempt_no: 1, amount: 1660, stripe_payment_method_id: 'pm_fake_1', stripe_mandate_id: 'mandate_fake_1', mandate_reference: 'MANDATE-1', linked: true, settlement_status: 'debit_processing' },
      { merchant_id: merchant2, status: 'processing', amount: 481, mandate_reference: 'MANDATE-2', linked: true, settlement_status: 'debit_processing' }
    ])
    expect((await attempts()).every((a) => typeof a.stripe_payment_intent_id === 'string' && typeof a.stripe_charge_id === 'string')).toBe(true)
    expect(await statementStatuses(merchant1)).toEqual(['waiting_sepa', 'waiting_sepa'])
    expect(await count("select count(*) c from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.amount_cents = 0")).toBe(0)

    provider.calls.length = 0
    await expect(run.execute({ now: later(DEBIT_DAY, 1) })).resolves.toMatchObject({ due: 0, created: 0 })
    expect(provider.calls).toHaveLength(0) // pas de second PaymentIntent
    expect(await count('select count(*) c from debit_attempts')).toBe(2)
  })

  it('never debits without a sent pre-notification, and never when the database refuses the notice period', async () => {
    await closeAndNotify({ notify: false })
    const provider = new FakeProvider()
    await expect(runner(provider, new FakeSources()).execute({ now: DEBIT_DAY })).resolves.toMatchObject({ due: 0, created: 0 })
    expect(provider.calls).toHaveLength(0)

    // Notification envoyée AUJOURD'HUI (horloge réelle) : la date annoncée est dans le futur ; même si l'horloge du worker est avancée, la base refuse (préavis).
    await closeAndNotifyAgainWithRealClock()
    const summary = await runner(provider, new FakeSources()).execute({ now: new Date(Date.now() + 30 * 86_400_000) })
    expect(summary).toMatchObject({ due: 2, created: 0, blocked: 2 })
    expect(provider.calls).toHaveLength(0)
    expect((await settlements()).map((s) => s.debit_blocked_reason)).toEqual(['debit_guard_refused', 'debit_guard_refused'])
    expect(await count('select count(*) c from debit_attempts')).toBe(0)
  })

  it('debits only with the notified mandate: another or no active mandate blocks that restaurant only, and clears once fixed', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    const sources = new FakeSources()
    sources.overrides.set(merchant1, { stripeAccountId: 'acct_fake_1', paymentMethodId: 'pm_new', mandateId: 'mandate_new', mandateReference: 'MANDATE-REPLACED' })
    const run = runner(provider, sources)
    await expect(run.execute({ now: DEBIT_DAY })).resolves.toMatchObject({ due: 2, created: 1, blocked: 1 })
    expect(provider.calls.map((c) => c.metadata.merchant_id)).toEqual([merchant2]) // l'autre restaurant n'est pas bloqué
    expect((await settlements()).map((s) => [s.merchant_id, s.status, s.debit_blocked_reason])).toEqual([[merchant1, 'notified', 'mandate_changed'], [merchant2, 'debit_processing', null]])

    sources.overrides.set(merchant1, null)
    await run.execute({ now: later(DEBIT_DAY, 5) })
    expect((await settlements())[0]).toMatchObject({ debit_blocked_reason: 'no_active_sepa_method' })
    expect(provider.calls).toHaveLength(1)

    sources.overrides.delete(merchant1)
    await expect(run.execute({ now: later(DEBIT_DAY, 10) })).resolves.toMatchObject({ created: 1 })
    expect((await settlements())[0]).toMatchObject({ status: 'debit_processing', debit_blocked_reason: null })
  })

  it('keeps restaurants fully independent: a REAL decline fails only that restaurant, a transient error is retried with the SAME key and creates one PaymentIntent', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    provider.createError.set(merchant1, new SepaDebitRejectedError('card_declined'))
    provider.createError.set(merchant2, new SepaDebitTransientError('api_connection_error'))
    const run = runner(provider, new FakeSources())
    await expect(run.execute({ now: DEBIT_DAY })).resolves.toMatchObject({ created: 2, failed: 1, retryable: 1 })
    expect(await attempts()).toMatchObject([
      { merchant_id: merchant1, status: 'failed', failure_code: 'debit_declined:card_declined', settlement_status: 'failed' },
      { merchant_id: merchant2, status: 'creating', sync_error_class: 'api_connection_error', stripe_payment_intent_id: null }
    ])
    expect(await statementStatuses(merchant1)).toEqual(['unpaid_restaurant', 'unpaid_restaurant'])
    expect(await statementStatuses(merchant2)).toEqual(['waiting_sepa'])

    await expect(run.execute({ now: later(DEBIT_DAY, 0.5) })).resolves.toMatchObject({ created: 0 }) // backoff : pas encore rejouée
    await run.execute({ now: later(DEBIT_DAY, 2) })
    const second = (await attempts())[1]!
    expect(second).toMatchObject({ status: 'processing', sync_error_class: null })
    const merchant2Calls = provider.calls.filter((c) => c.metadata.merchant_id === merchant2)
    expect(merchant2Calls).toHaveLength(2)
    expect(new Set(merchant2Calls.map((c) => c.idempotencyKey)).size).toBe(1) // même clé rejouée
    expect(provider.intents.size).toBe(1)
    // Un restaurant en échec ne déclenche aucun paiement livreur.
    expect(await count('select count(*) c from driver_transfers')).toBe(0)
  })

  it('follows processing until succeeded or failed, records the traceability R60 needs, and never regresses a final state', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    const run = runner(provider, new FakeSources())
    await run.execute({ now: DEBIT_DAY })
    const [first, second] = await attempts()
    provider.settle(first!.stripe_payment_intent_id as string, 'succeeded')
    provider.settle(second!.stripe_payment_intent_id as string, 'failed', 'account_closed')

    await expect(run.execute({ now: later(DEBIT_DAY, 5) })).resolves.toMatchObject({ synced: 0 }) // sondage seulement toutes les 15 min
    await expect(run.execute({ now: later(DEBIT_DAY, 20) })).resolves.toMatchObject({ synced: 2, succeeded: 1, failed: 1 })
    expect(await attempts()).toMatchObject([
      { merchant_id: merchant1, status: 'succeeded', stripe_charge_id: first!.stripe_charge_id, settlement_status: 'succeeded', failure_code: null },
      { merchant_id: merchant2, status: 'failed', failure_code: 'account_closed', settlement_status: 'failed' }
    ])
    expect(((await attempts())[0]!.available_on as Date).toISOString()).toBe('2026-09-10T00:00:00.000Z')
    expect(await statementStatuses(merchant1)).toEqual(['succeeded_held', 'succeeded_held'])
    expect(await statementStatuses(merchant2)).toEqual(['unpaid_restaurant'])

    // États finaux : plus jamais relus ni modifiés (même si Stripe « dit » autre chose ensuite).
    provider.settle(first!.stripe_payment_intent_id as string, 'failed')
    await expect(run.execute({ now: later(DEBIT_DAY, 60) })).resolves.toMatchObject({ synced: 0 })
    expect((await attempts())[0]).toMatchObject({ status: 'succeeded' })
    // R60 ne verra qu'un débit réussi ; l'impayé n'ouvre aucun Transfer (garde de base, R12).
    expect(await count("select count(*) c from debit_attempts where status = 'succeeded'")).toBe(1)
    expect(await count('select count(*) c from driver_transfers')).toBe(0)
  })

  it('survives a crash after Stripe created the PaymentIntent: the lease expires, the SAME key is replayed, one PaymentIntent, one attempt', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    let crashed = false
    const crashy: SepaDebitRepository = new Proxy(debitRepository, {
      get(target, property, receiver) {
        if (property === 'applyObservation') return async (input: Parameters<SepaDebitRepository['applyObservation']>[0]) => {
          if (!crashed) { crashed = true; throw new Error('simulated crash before recording the Stripe result') }
          return target.applyObservation(input)
        }
        return Reflect.get(target, property, receiver) as unknown
      }
    })
    const first = await runner(provider, new FakeSources(), crashy).execute({ now: DEBIT_DAY })
    expect(first.retryable).toBeGreaterThanOrEqual(1)
    await runner(provider, new FakeSources(), crashy).execute({ now: later(DEBIT_DAY, 5) })
    expect(provider.intents.size).toBe(2) // un PaymentIntent par restaurant, jamais deux pour le même règlement
    expect(await count('select count(*) c from debit_attempts')).toBe(2)
    expect((await attempts()).map((a) => a.status)).toEqual(['processing', 'processing'])
  })

  it('never creates two PaymentIntents when several workers run at the same time', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    await Promise.all([1, 2, 3].map(() => runner(provider, new FakeSources()).execute({ now: DEBIT_DAY })))
    expect(provider.intents.size).toBe(2)
    expect(await count('select count(*) c from debit_attempts')).toBe(2)
    expect(new Set(provider.calls.map((c) => c.idempotencyKey)).size).toBe(2)
  })

  it('separates technical errors from a real rejection: bad request, config or incoherence => technical_error, restaurant NEVER marked unpaid, others unaffected', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    provider.createError.set(merchant1, new SepaDebitTechnicalError('invalid_request:parameter_invalid'))
    const run = runner(provider, new FakeSources())
    await expect(run.execute({ now: DEBIT_DAY })).resolves.toMatchObject({ created: 2, technical: 1, failed: 0 })
    expect(await attempts()).toMatchObject([
      { merchant_id: merchant1, status: 'technical_error', failure_code: 'technical:invalid_request:parameter_invalid', settlement_status: 'technical_hold', stripe_payment_intent_id: null },
      { merchant_id: merchant2, status: 'processing', settlement_status: 'debit_processing' }
    ])
    expect(await statementStatuses(merchant1)).toEqual(['waiting_sepa', 'waiting_sepa']) // pas « unpaid_restaurant »
    expect(await count("select count(*) c from settlement_statements where status = 'unpaid_restaurant'")).toBe(0)
    provider.calls.length = 0
    await run.execute({ now: later(DEBIT_DAY, 60) })
    expect(provider.calls).toHaveLength(0) // aucune relance automatique : intervention requise
    expect(await count("select count(*) c from debit_attempts where status = 'technical_error'")).toBe(1)
  })

  it('treats a Stripe object that does not match the attempt, a canceled PaymentIntent and a lost creation as TECHNICAL, keeping the PaymentIntent id for investigation', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    provider.amountOverride = 1
    const run = runner(provider, new FakeSources())
    await expect(run.execute({ now: DEBIT_DAY })).resolves.toMatchObject({ technical: 2, failed: 0 })
    expect((await attempts()).map((a) => [a.status, a.failure_code, a.settlement_status])).toEqual([
      ['technical_error', 'technical:observation_mismatch_amount', 'technical_hold'], ['technical_error', 'technical:observation_mismatch_amount', 'technical_hold']
    ])
    expect((await attempts()).every((a) => typeof a.stripe_payment_intent_id === 'string')).toBe(true)
    expect(await count("select count(*) c from settlement_statements where status = 'unpaid_restaurant'")).toBe(0)
  })

  it('a canceled PaymentIntent is technical, and a creation lost beyond the idempotency window is technical (never a second automatic debit)', async () => {
    await closeAndNotify()
    const provider = new FakeProvider()
    const run = runner(provider, new FakeSources())
    await run.execute({ now: DEBIT_DAY })
    const [first, second] = await attempts()
    provider.intents.set(first!.stripe_payment_intent_id as string, { ...provider.intents.get(first!.stripe_payment_intent_id as string)!, paymentIntentStatus: 'canceled', chargeStatus: null })
    await expect(run.execute({ now: later(DEBIT_DAY, 20) })).resolves.toMatchObject({ technical: 1, failed: 0 })
    expect((await attempts())[0]).toMatchObject({ status: 'technical_error', failure_code: 'technical:payment_intent_canceled', settlement_status: 'technical_hold' })
    expect(await statementStatuses(merchant1)).toEqual(['waiting_sepa', 'waiting_sepa'])

    // Création jamais confirmée après 24 h (attempt « creating » sans PaymentIntent) : introuvable => technique.
    await pool.query("update debit_attempts set status = 'creating', stripe_payment_intent_id = null, stripe_charge_id = null, next_sync_at = null, created_at = $1::timestamptz where id = (select id from debit_attempts where status = 'processing')", [new Date(DEBIT_DAY.getTime() - 30 * 3_600_000)])
    provider.intents.clear()
    await run.execute({ now: later(DEBIT_DAY, 40) })
    expect((await attempts())[1]).toMatchObject({ status: 'technical_error', failure_code: 'technical:creation_not_confirmed', settlement_id: second!.settlement_id })
    expect(provider.calls).toHaveLength(2) // aucun rejeu de la clé après 24 h
  })
})

async function closeAndNotifyAgainWithRealClock(): Promise<void> {
  const sender: EmailSender = { send: async () => ({ provider: 'resend', messageId: `msg-${randomUUID()}` }) }
  await new SendPreNotificationsUseCase(new PostgresPreNotificationRepository(pool), {
    read: async (merchantId) => ({ email: 'resto@example.test', legalName: 'Resto', activeSepaMethod: { last4: '4242', mandateReference: `MANDATE-${merchantId.slice(-1)}` } })
  }, sender, { creditorId: 'CREDITOR-TEST', supportEmail: 'support@example.test' }, silent).execute({ now: new Date() })
}
