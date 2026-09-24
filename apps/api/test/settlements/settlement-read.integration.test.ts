import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import {
  PostgresDebitOpsRepository, PostgresDebitRetryRepository, PostgresDriverReversalRepository, PostgresReconciliationRepository, PostgresSettlementReadRepository, RequestDebitRetryUseCase, RequestDriverReversalUseCase
} from '../../src/modules/settlements/public.js'
import { closeNotifyAndDebit, driverId, dropSettlementWorldFixtures, later, merchantId, PAYRUN, payouts, resetSettlementWorld, settleDebits, type World } from '../support/settlement-payout-world.js'
import { lockSettlementSingleton } from '../support/settlement-singleton-lock.js'

// Base isolée requise. Lecture pure (R80) : la clôture, la pré-notification, les débits et le pay-run sont réels, seul Stripe est simulé.
vi.setConfig({ hookTimeout: 180_000 })
const isolated = /settlement|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const repo = new PostgresSettlementReadRepository(pool)
const ADMIN = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const ADMIN2 = 'aaaaaaaa-0000-4000-8000-0000000000a2'
let release: (() => Promise<void>) | undefined

const settlementOf = async (n: number): Promise<string> => (await pool.query<{ id: string }>('select id from merchant_settlements where merchant_id = $1::uuid', [merchantId(n)])).rows[0]!.id

/** Restaurant 1 : encaissé et payé ; restaurant 2 : prélèvement échoué ; restaurant 3 : prélèvement encore en cours. */
async function scenario(): Promise<World> {
  const world = await closeNotifyAndDebit([[1, 1, 475], [2, 1, 909], [3, 1, 401]])
  await settleDebits(world, { 1: 'succeeded', 2: 'failed' })
  await payouts(world).execute({ now: PAYRUN })
  return world
}

beforeAll(async () => { if (isolated) release = await lockSettlementSingleton(pool) })
afterEach(async () => { if (isolated) await resetSettlementWorld() })
afterAll(async () => {
  if (!isolated) return
  await dropSettlementWorldFixtures()
  await release?.()
})

describe.skipIf(!isolated)('settlement read model on PostgreSQL (R80)', () => {
  it('driver view: closed periods only, statements with the retained debit, payrun date and promise deadline; another driver sees nothing', async () => {
    await scenario()
    const periods = await repo.listDriverPeriods(driverId(1), 12)
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({ promiseDeadline: '2026-09-21' })
    expect(periods[0]!.payrunAt?.toISOString()).toBe(PAYRUN.toISOString())
    const byMerchant = new Map(periods[0]!.statements.map((s) => [s.merchantId, s]))
    expect(byMerchant.get(merchantId(1))).toMatchObject({ dueCents: 475, paidCents: 475, status: 'paid', settlementStatus: 'succeeded', debit: { attemptNo: 1, status: 'succeeded' }, incidentOpen: false })
    expect(byMerchant.get(merchantId(2))).toMatchObject({ dueCents: 909, paidCents: 0, status: 'unpaid_restaurant', settlementStatus: 'failed', debit: { attemptNo: 1, status: 'failed' } })
    expect(byMerchant.get(merchantId(3))).toMatchObject({ dueCents: 401, paidCents: 0, status: 'waiting_sepa', debit: { attemptNo: 1, status: 'processing' } })
    await expect(repo.listDriverPeriods('d2d2d2d2-0000-4000-8000-0000000000ff', 12)).resolves.toEqual([])
    await expect(repo.listDriverPeriods(driverId(1), 0)).resolves.toEqual([])
  })

  it('driver view: an open incident on the retained debit is exposed; a regularised debit (attempt 2 succeeded) replaces the failed one', async () => {
    const world = await scenario()
    const charge = (await pool.query<{ c: string }>("select stripe_charge_id as c from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid", [merchantId(1)])).rows[0]!.c
    const attempt = (await pool.query<{ id: string }>('select id from debit_attempts where stripe_charge_id = $1', [charge])).rows[0]!.id
    await new PostgresDebitOpsRepository(pool).applyIncidents({ attemptId: attempt, chargeId: charge, assessment: { incidents: [{ kind: 'dispute', externalId: 'dp_x', amountCents: 475, status: 'lost', reason: 'x' }], chargeUsable: false, restaurantOwedCents: 475 }, now: later(PAYRUN, 5) })
    const statement1 = (await repo.listDriverPeriods(driverId(1), 12))[0]!.statements.find((s) => s.merchantId === merchantId(1))!
    expect(statement1).toMatchObject({ paidCents: 475, incidentOpen: true }) // statement payé : inchangé, l'incident est seulement exposé
    void world
  })

  it('restaurant view: own settlements only, pre-notification, attempts, incidents, receivables, retry request, lines with merchant amounts only', async () => {
    await scenario()
    const rows = await repo.listMerchantSettlements(merchantId(1), 26)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amountCents: 570, deliveriesCount: 1, status: 'succeeded', retryRequested: false, openReceivablesCents: 0, incidents: [] })
    expect(rows[0]!.preNotification).toMatchObject({ attemptNo: 1, status: 'sent', debitDate: '2026-09-02', ibanLast4: '4242', mandateReference: 'MANDATE-1' })
    expect(rows[0]!.attempts.map((a) => [a.attemptNo, a.status])).toEqual([[1, 'succeeded']])

    // Relance demandée pour le restaurant 2 : une pré-notification de tentative 2 est en attente.
    await new RequestDebitRetryUseCase(new PostgresDebitRetryRepository(pool)).execute({ merchantSettlementId: await settlementOf(2), requestedBy: ADMIN, reason: 'Restaurant régularisé' })
    const failed = (await repo.listMerchantSettlements(merchantId(2), 26))[0]!
    expect(failed).toMatchObject({ status: 'failed', retryRequested: true })
    expect(failed.preNotification).toMatchObject({ attemptNo: 2, status: 'pending' })

    // Détail : le restaurant 2 ne peut pas lire le règlement du restaurant 1 ; les lignes ne portent QUE le montant restaurant.
    await expect(repo.getMerchantSettlement(merchantId(2), await settlementOf(1))).resolves.toBeNull()
    const detail = await repo.getMerchantSettlement(merchantId(1), await settlementOf(1))
    expect(detail!.lines).toHaveLength(1)
    expect(detail!.lines[0]).toMatchObject({ finalStatus: 'COMPLETED', merchantAmountCents: 570, deliveryCents: 475, serviceFeeCents: 95 })
    expect(Object.keys(detail!.lines[0]!).sort()).toEqual(['deliveryCents', 'finalStatus', 'finalizedAt', 'merchantAmountCents', 'orderId', 'serviceFeeCents'])
    // Le restaurant voit désormais SA propre décomposition livraison/service (ADR 0005, SF10) — jamais l'identité ou les
    // identifiants Stripe du livreur ni de la commande, qui restent exclus.
    expect(JSON.stringify(detail)).not.toMatch(/driverId|driverName|earning|acct_|pi_|ch_|py_/i)
    await expect(repo.listMerchantSettlements(merchantId(3), 0)).resolves.toEqual([])
  })

  it('admin overview: settlements with retry context, incidents, receivables, findings, transfers, reversals, blocked statements and dead letters', async () => {
    const world = await scenario()
    // incident + créance (restaurant 1), reversal demandée, constat de réconciliation, événement en dead_letter
    const charge = (await pool.query<{ c: string; id: string }>("select stripe_charge_id as c, a.id from debit_attempts a join merchant_settlements ms on ms.id = a.merchant_settlement_id where ms.merchant_id = $1::uuid", [merchantId(1)])).rows[0]!
    await new PostgresDebitOpsRepository(pool).applyIncidents({ attemptId: charge.id, chargeId: charge.c, assessment: { incidents: [{ kind: 'dispute', externalId: 'dp_admin', amountCents: 475, status: 'lost', reason: 'debit_not_authorized' }], chargeUsable: false, restaurantOwedCents: 475 }, now: later(PAYRUN, 5) })
    const transfer = (await pool.query<{ id: string }>("select id from driver_transfers where status = 'succeeded'")).rows[0]!.id
    await new RequestDriverReversalUseCase(new PostgresDriverReversalRepository(pool)).execute({ driverTransferId: transfer, category: 'driver_fault', reasonCode: 'fraud', reason: 'Fraude constatée', decisionReference: 'DEC-R80', amountCents: 100, requestedBy: ADMIN })
    await new PostgresReconciliationRepository(pool).recordFindings({ runId: null, findings: [{ kind: 'debit_disputed_after_success', scope: 'restaurant', refType: 'debit_attempt', refId: charge.id, expectedCents: 475, actualCents: 475, details: {} }], examined: [], now: later(PAYRUN, 6) })
    await pool.query("insert into settlement_stripe_events(event_id, event_type, status, attempt_count, last_error_class) values($1, 'charge.dispute.created', 'dead_letter', 15, 'UnknownSettlementObjectError')", [`evt_${randomUUID()}`])

    const overview = await repo.adminOverview(100)
    expect(overview.settlements).toHaveLength(3)
    const failed = overview.settlements.find((s) => s.merchantId === merchantId(2))!
    expect(failed).toMatchObject({ status: 'failed', statementsCount: 1, statementsPaidCount: 0, hasOpenRetryRequest: false })
    expect(failed.attempts).toMatchObject([{ attemptNo: 1, status: 'failed' }])
    expect(failed.notification).toMatchObject({ attemptNo: 1, status: 'sent', debitDate: '2026-09-02' })
    expect(overview.incidents).toMatchObject([{ merchantId: merchantId(1), kind: 'dispute', amountCents: 475, status: 'lost', receivableStatus: 'open' }])
    expect(overview.receivables).toMatchObject([{ scope: 'merchant', ownerId: merchantId(1), kind: 'sepa_dispute', amountCents: 475, status: 'open' }])
    expect(overview.findings).toMatchObject([{ kind: 'debit_disputed_after_success', scope: 'restaurant' }])
    expect(overview.transfers).toMatchObject([{ driverId: driverId(1), merchantId: merchantId(1), amountCents: 475, status: 'succeeded', reversedCents: 0 }])
    expect(overview.reversals).toMatchObject([{ driverId: driverId(1), status: 'pending_approval', reasonCode: 'fraud', amountCents: 100, requestedBy: ADMIN, approvedBy: null }])
    expect(overview.blockedStatements.map((b) => [b.merchantId, b.holdReason])).toEqual(expect.arrayContaining([[merchantId(2), 'unpaid_restaurant']]))
    expect(overview.deadLetters).toMatchObject([{ eventType: 'charge.dispute.created', attemptCount: 15, lastErrorClass: 'UnknownSettlementObjectError' }])
    void world
    void ADMIN2
  })
})
