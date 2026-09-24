import { describe, expect, it } from 'vitest'
import { OrdersCurrentWeekEstimator } from '../../src/modules/settlements/application/current-week-estimate.js'
import { GetAdminOverviewUseCase, GetDriverSettlementsUseCase, GetMerchantSettlementDetailUseCase, GetMerchantSettlementsUseCase } from '../../src/modules/settlements/application/settlement-read.js'

const period = {
  periodId: 'period', periodStart: new Date('2026-09-14T22:00:00.000Z'), periodEnd: new Date('2026-09-21T22:00:00.000Z'), closedAt: new Date('2026-09-21T22:05:00.000Z'), payrunAt: new Date('2026-09-23T08:00:00.000Z'), promiseDeadline: null,
  statements: [
    { statementId: 'one', merchantId: 'm1', dueCents: 100, paidCents: 20, status: 'unpaid_restaurant' as const, holdReason: null, settlementStatus: 'failed', debit: { attemptNo: 1, status: 'failed' as const }, incidentOpen: false },
    { statementId: 'two', merchantId: 'm1', dueCents: 50, paidCents: 50, status: 'paid' as const, holdReason: null, settlementStatus: 'succeeded', debit: { attemptNo: 1, status: 'succeeded' as const }, incidentOpen: false },
    { statementId: 'three', merchantId: 'm2', dueCents: 30, paidCents: 0, status: 'unpaid' as const, holdReason: null, settlementStatus: 'technical_hold', debit: null, incidentOpen: false }
  ]
}
const repository = { listDriverPeriods: async () => [period], listMerchantSettlements: async () => [], getMerchantSettlement: async () => null, adminOverview: async () => ({ settlements: [], incidents: [], receivables: [], findings: [], transfers: [], reversals: [], blockedStatements: [], deadLetters: [] }) }
const clock = () => new Date('2026-09-22T10:00:00.000Z')

describe('current week settlement estimate', () => {
  it('is null without go-live and filters the driver using full delivery amounts', async () => {
    const absent = new OrdersCurrentWeekEstimator(async () => ({ goLiveAt: null, payrunDelayBusinessDays: 1, promiseBusinessDays: 1 }), { listSettleableOrders: async () => [], countPreGoLiveFinalizedOrders: async () => 0 })
    await expect(absent.estimate('d', new Date('2026-09-21T10:00:00Z'))).resolves.toBeNull()
    const present = new OrdersCurrentWeekEstimator(async () => ({ goLiveAt: new Date('2026-01-01Z'), payrunDelayBusinessDays: 1, promiseBusinessDays: 1 }), { listSettleableOrders: async () => [{ orderId: '1', merchantId: 'm', driverId: 'd', deliveryCents: 101, serviceFeeCents: 20, pricingRuleVersion: 1, finalStatus: 'COMPLETED' as const, createdAt: new Date(), finalizedAt: new Date() }, { orderId: '2', merchantId: 'm', driverId: 'other', deliveryCents: 100, serviceFeeCents: 20, pricingRuleVersion: 1, finalStatus: 'COMPLETED' as const, createdAt: new Date(), finalizedAt: new Date() }], countPreGoLiveFinalizedOrders: async () => 0 })
    await expect(present.estimate('d', new Date('2026-09-21T10:00:00Z'))).resolves.toMatchObject({ deliveries: 1, estimatedAmountCents: 101, closesAt: '2026-09-27T22:05:00.000Z' })
  })
})

describe('settlement read use cases', () => {
  it('returns exact driver totals and does not query legal identities when the flag is off', async () => {
    let legalCalls = 0
    const directory = { merchantNames: async () => new Map([['m1', 'Restaurant un'], ['m2', 'Restaurant deux']]), driverNames: async () => new Map(), merchantLegalIdentity: async () => { legalCalls += 1; return { legalName: 'R', siret: '1', address: 'A' } } }
    const currentWeek = { estimate: async () => null }
    const result = await new GetDriverSettlementsUseCase(repository, directory, currentWeek, clock, false).execute({ driverId: 'driver', limit: 12 })
    expect(result.totals).toEqual({ totalCents: 180, sentCents: 70, pendingCents: 110, unpaidByRestaurantCents: 80 })
    expect(result.periods[0]?.statements.map((x) => x.expectedPaymentAt)).toEqual([null, null, '2026-09-23T08:00:00.000Z'])
    expect(result.periods[0]?.statements.map((x) => x.debtor)).toEqual([null, null, null])
    expect(legalCalls).toBe(0)
  })

  it('queries each eligible debtor once and exposes identity only on eligible display states', async () => {
    const calls: string[] = []
    const directory = { merchantNames: async () => new Map(), driverNames: async () => new Map(), merchantLegalIdentity: async (id: string) => { calls.push(id); return { legalName: id, siret: 's', address: 'a' } } }
    const result = await new GetDriverSettlementsUseCase(repository, directory, { estimate: async () => null }, clock, true).execute({ driverId: 'driver', limit: 12 })
    expect(calls).toEqual(['m1'])
    expect(result.periods[0]?.statements.map((x) => x.debtor?.legalName ?? null)).toEqual(['m1', null, null])
  })

  it('keeps merchant views limited to merchant data and returns null for a missing detail', async () => {
    const settlement = { merchantSettlementId: 'merchant-settlement', periodStart: new Date('2026-09-14T22:00:00.000Z'), periodEnd: new Date('2026-09-21T22:00:00.000Z'), amountCents: 100, deliveryCents: 80, serviceFeeCents: 20, deliveriesCount: 1, status: 'failed', preNotification: null, attempts: [{ attemptNo: 2, status: 'failed' as const, createdAt: clock(), updatedAt: clock() }], incidents: [], openReceivablesCents: 100, retryRequested: false }
    const repo = { ...repository, listMerchantSettlements: async () => [settlement], getMerchantSettlement: async () => null }
    const list = await new GetMerchantSettlementsUseCase(repo, clock).execute({ merchantId: 'm1', limit: 1 })
    // Le restaurant voit sa propre décomposition livraison/service (ADR 0005, SF10) mais jamais l'identité du
    // livreur, son gain, ni un identifiant Stripe brut.
    expect(JSON.stringify(list)).not.toMatch(/driverId|driverName|earning|stripe|failureCode/i)
    await expect(new GetMerchantSettlementDetailUseCase(repo, clock).execute({ merchantId: 'm1', merchantSettlementId: 'missing' })).resolves.toBeNull()
  })

  it('enriches admin names and selects the highest attempt with its retry decision', async () => {
    const rows = { settlements: [{ merchantSettlementId: 's', periodStart: clock(), periodEnd: clock(), merchantId: 'm', amountCents: 100, status: 'failed', debitBlockedReason: null, attempts: [{ attemptNo: 1, status: 'failed' as const, failureCode: 'old' }, { attemptNo: 3, status: 'technical_error' as const, failureCode: 'latest' }], notification: null, statementsCount: 2, statementsPaidCount: 1, hasOpenRetryRequest: false }], incidents: [], receivables: [], findings: [], transfers: [], reversals: [], blockedStatements: [], deadLetters: [] }
    const repo = { ...repository, adminOverview: async () => rows }
    const directory = { merchantNames: async () => new Map([['m', 'Restaurant']]), driverNames: async () => new Map(), merchantLegalIdentity: async () => null }
    const result = await new GetAdminOverviewUseCase(repo, directory, clock).execute({ limit: 1 })
    expect(result.settlements[0]).toMatchObject({ merchantName: 'Restaurant', latestAttempt: { attemptNo: 3, failureCode: 'latest' }, retry: { allowed: true, nextAttemptNo: 4, cause: 'technical_error' } })
  })
})
