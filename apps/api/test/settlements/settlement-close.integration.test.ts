import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { PostgresOrderRepository } from '../../src/modules/orders/infrastructure/postgres-order-repository.js'
import { CloseSettlementPeriodUseCase, EmailSendError, GoLiveNotSetError, PostgresPreNotificationRepository, PostgresSettlementCloseRepository, SendPreNotificationsUseCase, type EmailSender, type OutgoingEmail, type PreNotificationRecipient, type SettlementLogger } from '../../src/modules/settlements/public.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise (`source docs/work/r10-testdb.sh`) : ces tests posent un go_live_at de TEST (jamais celui du dev/prod).
// Semaine de clôture du lundi 2026-08-31 (00:05 Paris = 22:05Z la veille) ; go_live_at de test = 2026-08-15.
// Ces fichiers se partagent les tables de règlement : le verrou global peut attendre la fin de l'autre fichier.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const zoneId = '11111111-1111-1111-1111-111111111111'
const merchant1 = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'
const merchant2 = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'
const driver1 = 'dddddddd-dddd-dddd-dddd-ddddddddddd1'
const driver2 = 'dddddddd-dddd-dddd-dddd-ddddddddddd2'
const NOW = new Date('2026-08-30T22:05:00.000Z')
const orderIds: string[] = []
const SHAPE: Record<number, [number, number]> = { 401: [5000, 317], 475: [3000, 720], 909: [7000, 1500] }
const repository = new PostgresSettlementCloseRepository(pool)
const orderRepository = new PostgresOrderRepository(pool)
const useCase = new CloseSettlementPeriodUseCase(repository, orderRepository)
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

interface Spec { merchant: string; driver: string; earning: 401 | 475 | 909; status?: 'COMPLETED' | 'RETURNED' | 'RETURNING' | 'CANCELLED'; created: string; completed?: string; returned?: string }
async function order(spec: Spec): Promise<string> {
  const id = randomUUID()
  const status = spec.status ?? 'COMPLETED'
  const shape = SHAPE[spec.earning]!
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::order_status,'Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,$6::int,$7::int,$8::int,$9::timestamptz,$10::timestamptz)`,
    [id, spec.merchant, status === 'CANCELLED' ? null : spec.driver, zoneId, status, shape[0], shape[1], spec.earning, spec.created, status === 'COMPLETED' ? spec.completed ?? null : null])
  await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, spec.earning, Math.floor((spec.earning * 2_000) / 10_000)])
  orderIds.push(id)
  if (status === 'RETURNED') {
    await pool.query("insert into order_events(order_id,from_status,to_status,actor_type,correlation_id,created_at) values($1::uuid,'RETURNING','RETURNED','system',gen_random_uuid(),$2::timestamptz)", [id, spec.returned])
  }
  return id
}

// Fixtures de la semaine [2026-08-23T22:00Z, 2026-08-30T22:00Z) : microsecondes VOLONTAIRES (le JS ne les porte pas).
async function seedWeek(): Promise<void> {
  await order({ merchant: merchant1, driver: driver1, earning: 475, created: '2026-08-24 08:00:00+00', completed: '2026-08-25 10:00:00.123456+00' })
  await order({ merchant: merchant1, driver: driver2, earning: 909, created: '2026-08-24 09:00:00+00', completed: '2026-08-26 11:00:00+00' })
  await order({ merchant: merchant2, driver: driver1, earning: 401, status: 'RETURNED', created: '2026-08-24 10:00:00+00', returned: '2026-08-27 09:00:00.654321+00' })
  await order({ merchant: merchant1, driver: driver1, earning: 475, created: '2026-08-10 08:00:00+00', completed: '2026-08-25 12:00:00+00' }) // créée AVANT go_live_at : exclue et comptée
  await order({ merchant: merchant1, driver: driver1, earning: 475, created: '2026-08-24 08:00:00+00', completed: '2026-08-30 22:00:00+00' }) // = période suivante (borne haute exclue)
  await order({ merchant: merchant1, driver: driver1, earning: 475, status: 'RETURNING', created: '2026-08-24 08:00:00+00' })
  await order({ merchant: merchant1, driver: driver1, earning: 475, status: 'CANCELLED', created: '2026-08-24 08:00:00+00' })
}

const count = async (sql: string): Promise<number> => Number((await pool.query<{ c: string }>(sql)).rows[0]?.c)
const inTestRange = "period_start >= '2026-08-01'"

beforeAll(async () => {
  if (!isolated) return
  release = await lockSettlementSingleton(pool)
  for (const [id, name] of [[merchant1, 'Resto c1'], [merchant2, 'Resto c2']] as const) await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [id, name, zoneId])
  for (const [id, name] of [[driver1, 'Livreur d1'], [driver2, 'Livreur d2']] as const) await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [id, name, zoneId])
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

describe.skipIf(!isolated)('weekly settlement close on PostgreSQL (R40)', () => {
  it('closes the due weeks oldest first with the exact ledger, schedule, exclusions and microsecond-exact line timestamps', async () => {
    await setGoLive('2026-08-15T00:00:00Z')
    await seedWeek()
    const summaries = await useCase.execute({ now: NOW })
    expect(summaries.map((s) => [s.closingMonday, s.status, s.lines])).toEqual([['2026-08-17', 'closed', 0], ['2026-08-24', 'closed', 0], ['2026-08-31', 'closed', 3]])

    const period = (await pool.query(`select period_start, period_end, status, debit_date::text, payrun_at, promise_deadline::text, excluded_orders_count, go_live_at_snapshot from settlement_periods where period_start = '2026-08-23T22:00:00Z'`)).rows[0]
    expect(period).toMatchObject({ status: 'closed', debit_date: '2026-09-02', promise_deadline: '2026-09-21', excluded_orders_count: 1 })
    expect(new Date(period.payrun_at).toISOString()).toBe('2026-09-11T08:00:00.000Z')
    expect(new Date(period.go_live_at_snapshot).toISOString()).toBe('2026-08-15T00:00:00.000Z')

    const settlements = (await pool.query(`select ms.merchant_id, ms.amount_cents::int as amount, ms.driver_amount_cents::int as driver, ms.service_fee_cents::int as service from merchant_settlements ms join settlement_periods p on p.id = ms.period_id where p.period_start = '2026-08-23T22:00:00Z' order by ms.merchant_id`)).rows
    expect(settlements).toEqual([{ merchant_id: merchant1, amount: 475 + 95 + 909 + 181, driver: 475 + 909, service: 95 + 181 }, { merchant_id: merchant2, amount: 401 + 80, driver: 401, service: 80 }])
    const statements = (await pool.query(`select s.merchant_id, s.driver_id, s.due_cents::int as due, s.status from settlement_statements s join settlement_periods p on p.id = s.period_id where p.period_start = '2026-08-23T22:00:00Z' order by s.merchant_id, s.driver_id`)).rows
    expect(statements).toEqual([
      { merchant_id: merchant1, driver_id: driver1, due: 475, status: 'unpaid' },
      { merchant_id: merchant1, driver_id: driver2, due: 909, status: 'unpaid' },
      { merchant_id: merchant2, driver_id: driver1, due: 401, status: 'unpaid' }
    ])
    expect(await count("select count(*) c from settlement_lines l join orders o on o.id = l.order_id where l.finalized_at is distinct from case when o.status = 'COMPLETED' then o.completed_at else (select min(created_at) from order_events where order_id = o.id and to_status = 'RETURNED') end")).toBe(0)
    expect((await pool.query<{ final_status: string }>('select final_status from settlement_lines order by final_status')).rows.map((r) => r.final_status)).toEqual(['COMPLETED', 'COMPLETED', 'RETURNED']) // RETURNED payée, RETURNING/CANCELLED/hors fenêtre/avant go_live exclues
  })

  it('is idempotent: a second run closes nothing and a direct re-close reports already_closed without duplicating rows', async () => {
    await setGoLive('2026-08-15T00:00:00Z')
    await seedWeek()
    await useCase.execute({ now: NOW })
    await expect(useCase.execute({ now: NOW })).resolves.toEqual([])
    const [again] = await useCase.execute({ now: NOW, dryRun: true }) // rien d'exigible : simulation vide
    expect(again).toBeUndefined()
    expect(await count(`select count(*) c from settlement_periods where ${inTestRange}`)).toBe(3)
    expect(await count('select count(*) c from settlement_lines')).toBe(3)
  })

  it('serializes concurrent closers: exactly one wins per period, no duplicate rows', async () => {
    await setGoLive('2026-08-15T00:00:00Z')
    await seedWeek()
    const [a, b] = await Promise.all([useCase.execute({ now: NOW }), useCase.execute({ now: NOW })])
    const statuses = [...a, ...b].filter((s) => s.closingMonday === '2026-08-31').map((s) => s.status).sort()
    expect(statuses).toEqual(['already_closed', 'closed']) // le perdant relit la période sous verrou : jamais d'erreur ni de doublon
    expect(await count(`select count(*) c from settlement_periods where ${inTestRange}`)).toBe(3)
    expect(await count('select count(*) c from settlement_lines')).toBe(3)
    expect(await count('select count(*) c from settlement_statements')).toBe(3)
  })

  it('refuses without go_live_at (test orders are never settled) and writes nothing', async () => {
    await seedWeek()
    await expect(useCase.execute({ now: NOW })).rejects.toBeInstanceOf(GoLiveNotSetError)
    expect(await count('select count(*) c from settlement_periods')).toBe(0)
  })

  it('dry run reads and computes but writes nothing', async () => {
    await setGoLive('2026-08-15T00:00:00Z')
    await seedWeek()
    const summaries = await useCase.execute({ now: NOW, dryRun: true })
    expect(summaries.map((s) => s.status)).toEqual(['dry_run', 'dry_run', 'dry_run'])
    expect(summaries[2]).toMatchObject({ lines: 3, statements: 3, merchantSettlements: 2, merchantAmountCents: 475 + 95 + 909 + 181 + 401 + 80, dueCents: 475 + 909 + 401, feeCents: 95 + 181 + 80, excludedOrdersCount: 1 })
    expect(await count('select count(*) c from settlement_periods')).toBe(0)
  })

  it('rolls back the whole period when totals cannot be reconciled (deferred constraints), leaving no partial period', async () => {
    await setGoLive('2026-08-15T00:00:00Z')
    await seedWeek()
    const [first] = await useCase.execute({ now: NOW, dryRun: true })
    expect(first).toBeDefined()
    // Une ligne référence une commande inexistante : le grand livre ne se réconcilie pas => la transaction entière est annulée.
    const bad = { ...(await orderRepository.listSettleableOrders({ finalizedFrom: new Date('2026-08-23T22:00:00Z'), finalizedTo: new Date('2026-08-30T22:00:00Z'), createdNotBefore: new Date('2026-08-15T00:00:00Z') }))[0]!, orderId: randomUUID() }
    const flawed = new CloseSettlementPeriodUseCase(repository, {
      listSettleableOrders: async () => [bad],
      countPreGoLiveFinalizedOrders: async () => 0
    })
    await expect(flawed.execute({ now: NOW })).rejects.toThrow()
    expect(await count('select count(*) c from settlement_periods')).toBe(0)
    expect(await count('select count(*) c from settlement_lines')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// R41 : pré-notification SEPA du lundi (Resend simulé ; base réelle). Les règlements viennent de la vraie clôture R40.
// ---------------------------------------------------------------------------------------------------------------------------------
const silentLogger: SettlementLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const preRepository = new PostgresPreNotificationRepository(pool)
class RecordingSender implements EmailSender {
  public readonly sent: OutgoingEmail[] = []
  public failWith: EmailSendError | null = null
  public async send(email: OutgoingEmail): Promise<{ provider: string; messageId: string }> {
    if (this.failWith !== null) throw this.failWith
    this.sent.push(email)
    return { provider: 'resend', messageId: `msg-${this.sent.length}` }
  }
}
function preNotifier(sender: EmailSender, recipient: Partial<PreNotificationRecipient> = {}): SendPreNotificationsUseCase {
  return new SendPreNotificationsUseCase(preRepository, {
    read: async (merchantId) => ({ email: `${merchantId === merchant1 ? 'resto1' : 'resto2'}@example.test`, legalName: merchantId === merchant1 ? 'Resto Un' : 'Resto Deux', activeSepaMethod: { last4: '4242', mandateReference: `MANDATE-${merchantId.slice(-1)}` }, ...recipient })
  }, sender, { creditorId: 'CREDITOR-TEST', supportEmail: 'support@example.test' }, silentLogger)
}
async function closeWeek(): Promise<void> {
  await setGoLive('2026-08-15T00:00:00Z')
  await seedWeek()
  await useCase.execute({ now: NOW })
}
async function insertDebit(merchantId: string): Promise<void> {
  const row = (await pool.query<{ id: string; amount: string; mandate: string | null }>(`select ms.id, ms.amount_cents::text as amount, (select n.mandate_reference from settlement_pre_notifications n where n.merchant_settlement_id = ms.id) as mandate from merchant_settlements ms where ms.merchant_id = $1::uuid and ms.amount_cents > 0`, [merchantId])).rows[0]!
  await pool.query(`insert into debit_attempts(merchant_settlement_id,attempt_no,amount_cents,stripe_account_id,idempotency_key,status,livemode,mandate_reference) values($1::uuid,1,$2::bigint,'acct_test',$3,'creating',false,$4)`, [row.id, row.amount, `debit-${randomUUID()}`, row.mandate])
}
const notifications = async (): Promise<Array<Record<string, unknown>>> => (await pool.query(`select n.status, n.attempt_count, n.last_error_class, n.amount_cents::int as amount, n.debit_date::text as debit_date, n.iban_last4, n.mandate_reference, n.creditor_id, n.recipient_email, n.provider_message_id, n.sent_at, ms.merchant_id, ms.status as settlement_status, ms.pre_notified_at
  from settlement_pre_notifications n join merchant_settlements ms on ms.id = n.merchant_settlement_id order by ms.merchant_id`)).rows

describe.skipIf(!isolated)('SEPA pre-notification on PostgreSQL (R41)', () => {
  it('sends ONE exact-amount email per restaurant settlement, records what was sent, and is idempotent on rerun', async () => {
    await closeWeek()
    const sender = new RecordingSender()
    const notifier = preNotifier(sender)
    await expect(notifier.execute({ now: NOW })).resolves.toMatchObject({ enqueued: 2, claimed: 2, sent: 2, failed: 0 })
    expect(sender.sent.map((mail) => mail.to).sort()).toEqual(['resto1@example.test', 'resto2@example.test'])
    const first = sender.sent.find((mail) => mail.to === 'resto1@example.test')!
    expect(first.subject).toBe('Prélèvement SEPA de 16,60\u00a0€ le mercredi 2 septembre 2026')
    expect(first.text).toContain('IBAN se terminant par 4242')
    expect(sender.sent.find((mail) => mail.to === 'resto2@example.test')!.subject).toContain('4,81\u00a0€')
    expect(new Set(sender.sent.map((mail) => mail.idempotencyKey)).size).toBe(2)

    const rows = await notifications()
    expect(rows).toMatchObject([
      { merchant_id: merchant1, status: 'sent', amount: 1660, debit_date: '2026-09-02', iban_last4: '4242', creditor_id: 'CREDITOR-TEST', recipient_email: 'resto1@example.test', settlement_status: 'notified' },
      { merchant_id: merchant2, status: 'sent', amount: 481, debit_date: '2026-09-02', settlement_status: 'notified' }
    ])
    expect(rows.every((row) => (row.sent_at as Date).toISOString() === NOW.toISOString() && (row.pre_notified_at as Date).toISOString() === NOW.toISOString())).toBe(true)

    sender.sent.length = 0
    await expect(notifier.execute({ now: new Date(NOW.getTime() + 3_600_000) })).resolves.toMatchObject({ enqueued: 0, claimed: 0, sent: 0 })
    expect(sender.sent).toHaveLength(0)
    expect(await count('select count(*) c from settlement_pre_notifications')).toBe(2)
  })

  it('never sends twice when two workers run at the same time', async () => {
    await closeWeek()
    const sender = new RecordingSender()
    await Promise.all([preNotifier(sender).execute({ now: NOW }), preNotifier(sender).execute({ now: NOW }), preNotifier(sender).execute({ now: NOW })])
    expect(sender.sent).toHaveLength(2)
    expect((await notifications()).map((row) => row.status)).toEqual(['sent', 'sent'])
  })

  it('traces a send failure as retryable, never as sent, blocks the debit, then succeeds on retry', async () => {
    await closeWeek()
    const sender = new RecordingSender()
    sender.failWith = new EmailSendError('Resend responded with status 500', 'transient')
    const notifier = preNotifier(sender)
    await expect(notifier.execute({ now: new Date() })).resolves.toMatchObject({ sent: 0, failed: 2 })
    expect(await notifications()).toMatchObject([{ status: 'failed', attempt_count: 1, last_error_class: 'email_transient', pre_notified_at: null, settlement_status: 'pending_notification' }, { status: 'failed', last_error_class: 'email_transient', pre_notified_at: null }])
    await expect(insertDebit(merchant1)).rejects.toThrow(/pré-notification/)

    sender.failWith = null
    await expect(notifier.execute({ now: new Date() })).resolves.toMatchObject({ claimed: 0 }) // backoff : pas de nouvelle tentative immédiate
    await pool.query("update settlement_pre_notifications set next_attempt_at = now() where status = 'failed'")
    await expect(notifier.execute({ now: new Date() })).resolves.toMatchObject({ sent: 2, failed: 0 })
    expect(sender.sent).toHaveLength(2)
    expect(await notifications()).toMatchObject([{ status: 'sent', attempt_count: 2, last_error_class: null }, { status: 'sent', attempt_count: 2 }])
  })

  it('does not send when the mandate or the recipient is unusable, and keeps the notification retryable', async () => {
    await closeWeek()
    const sender = new RecordingSender()
    await preNotifier(sender, { activeSepaMethod: null }).execute({ now: new Date() })
    await preNotifier(sender, { email: null }).execute({ now: new Date() }) // pas de reprise avant le backoff : reste failed
    expect(sender.sent).toHaveLength(0)
    expect((await notifications()).map((row) => [row.status, row.last_error_class])).toEqual([['failed', 'no_active_sepa_method'], ['failed', 'no_active_sepa_method']])
    expect(await count('select count(*) c from merchant_settlements where pre_notified_at is not null')).toBe(0)
  })

  it('takes over an expired lease (crashed worker) with the SAME provider idempotency key', async () => {
    await closeWeek()
    await preRepository.enqueueMissing()
    const [lost] = await preRepository.claimDue({ limit: 1, leaseSeconds: 120, maxAttempts: 30 })
    await pool.query("update settlement_pre_notifications set lease_expires_at = now() - interval '1 second' where status = 'sending'")
    const sender = new RecordingSender()
    await preNotifier(sender).execute({ now: NOW })
    expect(sender.sent).toHaveLength(2)
    expect(sender.sent.some((mail) => mail.idempotencyKey === `settlement-pre-notification-${lost!.id}`)).toBe(true)
    const stale = await preRepository.markSent({ id: lost!.id, claimToken: lost!.claimToken, sentAt: NOW, snapshot: { recipientEmail: 'x@example.test', debitDate: '2026-09-02' as never, ibanLast4: '0000', mandateReference: 'X', creditorId: 'X', provider: 'resend', providerMessageId: 'stale' } })
    expect(stale).toBe('lost_claim')
  })

  it('lets a debit through only after a sent pre-notification of at least 2 calendar days and never before the announced date', async () => {
    await closeWeek()
    const sender = new RecordingSender()
    await preNotifier(sender).execute({ now: NOW }) // annoncée le 2026-08-31 pour le 2026-09-02 ; aujourd'hui (horloge réelle) est bien après
    await expect(insertDebit(merchant1)).resolves.toBeUndefined()
    await expect(insertDebit(merchant2)).resolves.toBeUndefined()
  })

  it('refuses a debit the same day as the notification, and forged or altered pre_notified_at / sent notifications', async () => {
    await closeWeek()
    await preNotifier(new RecordingSender()).execute({ now: new Date() })
    await expect(insertDebit(merchant1)).rejects.toThrow(/deux jours calendaires|précéder la date/)
    await expect(pool.query("update merchant_settlements set pre_notified_at = now() - interval '5 days' where merchant_id = $1::uuid", [merchant1])).rejects.toThrow(/immuable/)
    await expect(pool.query("update settlement_pre_notifications set sent_at = now() - interval '5 days'")).rejects.toThrow(/immuable/)
    await expect(pool.query('delete from settlement_pre_notifications')).rejects.toThrow(/immuable/)
    await expect(pool.query("update settlement_pre_notifications set amount_cents = 1")).rejects.toThrow()
  })

  it('refuses to set pre_notified_at by hand when no pre-notification was sent', async () => {
    await closeWeek()
    await preRepository.enqueueMissing()
    await expect(pool.query("update merchant_settlements set pre_notified_at = now() - interval '5 days' where merchant_id = $1::uuid", [merchant1])).rejects.toThrow(/pré-notification envoyée/)
  })
})
