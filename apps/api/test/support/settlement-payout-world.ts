import { randomUUID } from 'node:crypto'
import { pool } from '../../src/platform/db.js'
import { PostgresOrderRepository } from '../../src/modules/orders/infrastructure/postgres-order-repository.js'
import {
  CloseSettlementPeriodUseCase, PostgresDriverPayoutRepository, PostgresPreNotificationRepository, PostgresSepaDebitRepository, PostgresSettlementCloseRepository, RunDriverPayoutsUseCase, RunSepaDebitsUseCase, SendPreNotificationsUseCase,
  TransferTransientError,
  type CreateTransferInput, type DriverAccountLiveReader, type DriverPayoutRepository, type DriverTransferProvider, type EmailSender, type TransferResult
} from '../../src/modules/settlements/public.js'
import { deleteTestOrders } from './cleanup-orders.js'
import { FakeProvider, FakeSources, silentLogger } from './settlement-fakes.js'

// Monde de test partagé (R60/R61) : clôture R40, pré-notification R41 et débits R50 RÉELS sur PostgreSQL ; seul Stripe est simulé.
export const zoneId = '11111111-1111-1111-1111-111111111111'
export const merchantId = (n: number): string => `d1d1d1d1-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
export const driverId = (n: number): string => `d2d2d2d2-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
export const CLOSE_NOW = new Date('2026-08-30T22:05:00.000Z')
export const DEBIT_DAY = new Date('2026-09-02T06:00:00.000Z')
export const PAYRUN = new Date('2026-09-11T08:00:00.000Z')
const SHAPE: Record<number, [number, number]> = { 401: [5000, 317], 475: [3000, 720], 909: [7000, 1500] }
const orderIds: string[] = []
export const merchantsUsed = new Set<number>()
export const driversUsed = new Set<number>()

export const later = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * 60_000)
export const count = async (sql: string): Promise<number> => Number((await pool.query<{ c: string }>(sql)).rows[0]?.c)

export async function setGoLive(value: string | null): Promise<void> {
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

export class FakeTransfers implements DriverTransferProvider {
  public readonly livemode = false
  public readonly calls: CreateTransferInput[] = []
  public readonly created: TransferResult[] = []
  public readonly annotations: Array<{ destinationPaymentId: string; description: string }> = []
  public readonly errorsOnce = new Map<string, Error>() // par statement_id
  public annotateFails = false
  private readonly byKey = new Map<string, TransferResult>()
  private readonly byMeta = new Map<string, TransferResult>()

  public async createTransfer(input: CreateTransferInput): Promise<TransferResult> {
    this.calls.push(input)
    const once = this.errorsOnce.get(input.metadata.statement_id)
    if (once !== undefined) { this.errorsOnce.delete(input.metadata.statement_id); throw once }
    const existing = this.byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    const result: TransferResult = { transferId: `tr_fake_${this.created.length + 1}`, amountCents: input.amountCents, currency: 'eur', destinationAccountId: input.destinationAccountId, sourceTransactionId: input.sourceTransactionId, destinationPaymentId: `py_fake_${this.created.length + 1}`, livemode: false }
    this.created.push(result)
    this.byKey.set(input.idempotencyKey, result)
    this.byMeta.set(input.metadata.driver_transfer_id, result)
    return result
  }
  public async findTransfer(input: { transferGroup: string; driverTransferId: string }): Promise<TransferResult | null> { return this.byMeta.get(input.driverTransferId) ?? null }
  public async annotateDestinationPayment(input: { destinationAccountId: string; destinationPaymentId: string; description: string; metadata: Record<string, string> }): Promise<void> {
    if (this.annotateFails) throw new TransferTransientError('api_connection_error')
    this.annotations.push({ destinationPaymentId: input.destinationPaymentId, description: input.description })
  }
}

export class FakeAccounts implements DriverAccountLiveReader {
  public readonly notReady = new Set<string>()
  public reads = 0
  public async isTransferReady(stripeAccountId: string): Promise<boolean> { this.reads += 1; return !this.notReady.has(stripeAccountId) }
}

export interface World { debits: FakeProvider; transfers: FakeTransfers; accounts: FakeAccounts; sources: FakeSources }

/** Lignes [restaurant n°, livreur n°, gain] : une commande terminée par ligne, dans la semaine du 24 au 30 août. */
export async function closeNotifyAndDebit(rows: Array<[number, number, 401 | 475 | 909]>): Promise<World> {
  await setGoLive('2026-08-15T00:00:00Z')
  for (const [m, d] of rows) {
    if (!merchantsUsed.has(m)) { merchantsUsed.add(m); await pool.query('insert into merchants(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [merchantId(m), `Resto d1-${m}`, zoneId]) }
    if (!driversUsed.has(d)) {
      driversUsed.add(d)
      await pool.query('insert into drivers(id,name,zone_id) values($1::uuid,$2,$3::uuid) on conflict do nothing', [driverId(d), `Livreur d2-${d}`, zoneId])
      await pool.query(`insert into driver_connect_accounts(driver_id,stripe_account_id,entity_type,livemode,transfers_status,payouts_status,requirements_state) values($1::uuid,$2,'individual',false,'active','active','none') on conflict (driver_id) do update set transfers_status = 'active', requirements_state = 'none', restricted_at = null`, [driverId(d), `acct_driver_${d}`])
    }
  }
  for (const [m, d, earning] of rows) {
    const id = randomUUID()
    const shape = SHAPE[earning]!
    await pool.query(
      `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,created_at,completed_at)
       values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'COMPLETED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,$5::int,$6::int,$7::int,'2026-08-24 08:00:00+00','2026-08-26 10:00:00+00')`,
      [id, merchantId(m), driverId(d), zoneId, shape[0], shape[1], earning])
    await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, earning, Math.floor((earning * 2_000) / 10_000)])
    orderIds.push(id)
  }
  await new CloseSettlementPeriodUseCase(new PostgresSettlementCloseRepository(pool), new PostgresOrderRepository(pool)).execute({ now: CLOSE_NOW })
  const sender: EmailSender = { send: async () => ({ provider: 'resend', messageId: `msg-${randomUUID()}` }) }
  await new SendPreNotificationsUseCase(new PostgresPreNotificationRepository(pool), {
    read: async (mid) => ({ email: 'resto@example.test', legalName: 'Resto', activeSepaMethod: { last4: '4242', mandateReference: `MANDATE-${mid.slice(-1)}` } })
  }, sender, { creditorId: 'CREDITOR-TEST', supportEmail: 'support@example.test' }, silentLogger).execute({ now: CLOSE_NOW })
  const world: World = { debits: new FakeProvider(), transfers: new FakeTransfers(), accounts: new FakeAccounts(), sources: new FakeSources() }
  await new RunSepaDebitsUseCase(new PostgresSepaDebitRepository(pool), world.sources, world.debits, silentLogger, { syncIntervalSeconds: 900 }).execute({ now: DEBIT_DAY })
  return world
}

/** Fait aboutir le débit d'un restaurant chez Stripe (fake) puis relit (R50). */
export async function settleDebits(world: World, outcomes: Record<number, 'succeeded' | 'failed'>, at: Date = later(DEBIT_DAY, 30)): Promise<void> {
  for (const [m, outcome] of Object.entries(outcomes)) {
    const pi = (await pool.query<{ pi: string }>('select a.stripe_payment_intent_id as pi from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid order by a.attempt_no desc limit 1', [merchantId(Number(m))])).rows[0]!.pi
    world.debits.settle(pi, outcome, 'account_closed')
  }
  await new RunSepaDebitsUseCase(new PostgresSepaDebitRepository(pool), world.sources, world.debits, silentLogger, { syncIntervalSeconds: 900 }).execute({ now: at })
}

export function payouts(world: World, repository: DriverPayoutRepository = new PostgresDriverPayoutRepository(pool)): RunDriverPayoutsUseCase {
  return new RunDriverPayoutsUseCase(repository, world.debits, world.transfers, world.accounts, silentLogger, { recheckDelaySeconds: 600 })
}


export async function resetSettlementWorld(): Promise<void> {
  await pool.query('truncate table settlement_lines, settlement_statements, merchant_settlements, settlement_periods, settlement_stripe_events, settlement_reconciliation_findings, settlement_reconciliation_runs cascade')
  await deleteTestOrders(pool, orderIds.splice(0))
  await setGoLive(null)
}
export async function dropSettlementWorldFixtures(): Promise<void> {
  await pool.query('delete from driver_payout_observations where driver_id = any($1::uuid[])', [[...driversUsed].map(driverId)])
  await pool.query('delete from driver_connect_accounts where driver_id = any($1::uuid[])', [[...driversUsed].map(driverId)])
  await pool.query('delete from drivers where id = any($1::uuid[])', [[...driversUsed].map(driverId)])
  await pool.query('delete from merchants where id = any($1::uuid[])', [[...merchantsUsed].map(merchantId)])
}
