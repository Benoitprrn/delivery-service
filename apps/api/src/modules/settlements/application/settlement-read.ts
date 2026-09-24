import { decideDebitRetry } from '../domain/debit-retry.js'
import { driverStatementDisplayState, expectedPaymentAt, incidentOpenCents, merchantAttemptOutcome, merchantDisplayState, summarizeDriverPeriod, sumTotals } from '../domain/settlement-display.js'
import type { AdminOverviewResponse, DriverSettlementsResponse, MerchantSettlementDetailResponse, MerchantSettlementsResponse } from '../domain/settlement-views.js'
import type { SettlementDirectory, SettlementReadRepository } from '../ports/settlement-read.js'
import type { CurrentWeekEstimator } from './current-week-estimate.js'

const iso = (value: Date | null): string | null => value?.toISOString() ?? null
const name = (names: Map<string, string>, id: string): string => names.get(id) ?? ''

export class GetDriverSettlementsUseCase {
  public constructor(private readonly repository: SettlementReadRepository, private readonly directory: SettlementDirectory, private readonly currentWeek: CurrentWeekEstimator, private readonly clock: () => Date, private readonly identityVisible = false) {}
  public async execute(input: { driverId: string; limit: number }): Promise<DriverSettlementsResponse> {
    const rows = await this.repository.listDriverPeriods(input.driverId, input.limit)
    const merchantIds = [...new Set(rows.flatMap((period) => period.statements.map((statement) => statement.merchantId)))]
    const merchantNames = await this.directory.merchantNames(merchantIds)
    const states = rows.flatMap((period) => period.statements.map((statement) => ({ merchantId: statement.merchantId, state: driverStatementDisplayState(statement) })))
    const debtorIds = this.identityVisible ? [...new Set(states.filter(({ state }) => state === 'awaiting_restaurant_payment' || state === 'restaurant_incident').map(({ merchantId }) => merchantId))] : []
    const debtors = new Map<string, Awaited<ReturnType<SettlementDirectory['merchantLegalIdentity']>>>()
    await Promise.all(debtorIds.map(async (merchantId) => { debtors.set(merchantId, await this.directory.merchantLegalIdentity(merchantId)) }))
    const periods = rows.map((period) => {
      const statements = period.statements.map((statement) => {
        const displayState = driverStatementDisplayState(statement)
        return { statementId: statement.statementId, merchantId: statement.merchantId, merchantName: name(merchantNames, statement.merchantId), dueCents: statement.dueCents, paidCents: statement.paidCents, remainingCents: statement.dueCents - statement.paidCents, displayState, expectedPaymentAt: expectedPaymentAt(displayState, period.payrunAt), debtor: (displayState === 'awaiting_restaurant_payment' || displayState === 'restaurant_incident') ? debtors.get(statement.merchantId) ?? null : null }
      })
      const totals = summarizeDriverPeriod(statements)
      return { periodId: period.periodId, periodStart: period.periodStart.toISOString(), periodEnd: period.periodEnd.toISOString(), closedAt: iso(period.closedAt), payrunAt: iso(period.payrunAt), promiseDeadline: period.promiseDeadline, ...totals, statements }
    })
    return { generatedAt: this.clock().toISOString(), identityVisible: this.identityVisible, currentWeek: await this.currentWeek.estimate(input.driverId, this.clock()), totals: sumTotals(periods), periods }
  }
}

function merchantView(row: import('../ports/settlement-read.js').MerchantSettlementRow) {
  const notification = row.preNotification
  const latestAttempt = row.attempts.reduce<typeof row.attempts[number] | null>((latest, attempt) => latest === null || attempt.attemptNo > latest.attemptNo ? attempt : latest, null)
  return { merchantSettlementId: row.merchantSettlementId, periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(), amountCents: row.amountCents, deliveryCents: row.deliveryCents, serviceFeeCents: row.serviceFeeCents, deliveriesCount: row.deliveriesCount, displayState: merchantDisplayState(row), debit: { date: notification?.debitDate ?? null, ibanLast4: notification?.ibanLast4 ?? null, mandateReference: notification?.mandateReference ?? null, attemptNo: latestAttempt?.attemptNo ?? null, preNotifiedAt: iso(notification?.sentAt ?? null) }, retryPending: row.retryRequested, incidentOpenCents: incidentOpenCents(row.incidents), openReceivableCents: row.openReceivablesCents }
}

export class GetMerchantSettlementsUseCase {
  public constructor(private readonly repository: SettlementReadRepository, private readonly clock: () => Date) {}
  public async execute(input: { merchantId: string; limit: number }): Promise<MerchantSettlementsResponse> { return { generatedAt: this.clock().toISOString(), settlements: (await this.repository.listMerchantSettlements(input.merchantId, input.limit)).map(merchantView) } }
}

export class GetMerchantSettlementDetailUseCase {
  public constructor(private readonly repository: SettlementReadRepository, private readonly clock: () => Date) {}
  public async execute(input: { merchantId: string; merchantSettlementId: string }): Promise<MerchantSettlementDetailResponse | null> {
    const result = await this.repository.getMerchantSettlement(input.merchantId, input.merchantSettlementId)
    if (result === null) return null
    return { generatedAt: this.clock().toISOString(), settlement: merchantView(result.row), attempts: result.row.attempts.map((attempt) => ({ attemptNo: attempt.attemptNo, outcome: merchantAttemptOutcome(attempt.status), at: attempt.updatedAt.toISOString() })), lines: result.lines.map((line) => ({ orderId: line.orderId, finalizedAt: line.finalizedAt.toISOString(), status: line.finalStatus, amountCents: line.merchantAmountCents, deliveryCents: line.deliveryCents, serviceFeeCents: line.serviceFeeCents })) }
  }
}

export class GetAdminOverviewUseCase {
  public constructor(private readonly repository: SettlementReadRepository, private readonly directory: SettlementDirectory, private readonly clock: () => Date) {}
  public async execute(input: { limit: number }): Promise<AdminOverviewResponse> {
    const rows = await this.repository.adminOverview(input.limit)
    const merchantIds = [...new Set([...rows.settlements.map((x) => x.merchantId), ...rows.incidents.map((x) => x.merchantId), ...rows.transfers.map((x) => x.merchantId), ...rows.blockedStatements.map((x) => x.merchantId)])]
    const driverIds = [...new Set([...rows.receivables.filter((x) => x.scope === 'driver').map((x) => x.ownerId), ...rows.transfers.map((x) => x.driverId), ...rows.reversals.map((x) => x.driverId), ...rows.blockedStatements.map((x) => x.driverId)])]
    const [merchants, drivers] = await Promise.all([this.directory.merchantNames(merchantIds), this.directory.driverNames(driverIds)])
    return { generatedAt: this.clock().toISOString(), settlements: rows.settlements.map((row) => {
      const retry = decideDebitRetry({ settlementAmountCents: row.amountCents, attempts: row.attempts.map(({ attemptNo, status }) => ({ attemptNo, status })), hasOpenRetryRequest: row.hasOpenRetryRequest })
      const latestAttempt = row.attempts.reduce<typeof row.attempts[number] | null>((latest, attempt) => latest === null || attempt.attemptNo > latest.attemptNo ? attempt : latest, null)
      return { merchantSettlementId: row.merchantSettlementId, periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(), merchantId: row.merchantId, merchantName: name(merchants, row.merchantId), amountCents: row.amountCents, status: row.status, debitBlockedReason: row.debitBlockedReason, latestAttempt: latestAttempt === null ? null : { attemptNo: latestAttempt.attemptNo, status: latestAttempt.status, failureCode: latestAttempt.failureCode }, notification: row.notification === null ? null : { ...row.notification, sentAt: iso(row.notification.sentAt), debitDate: row.notification.debitDate }, statementsCount: row.statementsCount, statementsPaidCount: row.statementsPaidCount, retry: retry.allowed ? { allowed: true, nextAttemptNo: retry.nextAttemptNo, cause: retry.cause } : retry }
    }), incidents: rows.incidents.map((row) => ({ ...row, merchantName: name(merchants, row.merchantId), detectedAt: row.detectedAt.toISOString() })), receivables: rows.receivables.map((row) => ({ ...row, ownerName: row.scope === 'merchant' ? name(merchants, row.ownerId) : name(drivers, row.ownerId), createdAt: row.createdAt.toISOString() })), findings: rows.findings.map((row) => ({ ...row, firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString() })), transfers: rows.transfers.map((row) => ({ ...row, driverName: name(drivers, row.driverId), merchantName: name(merchants, row.merchantId), succeededAt: iso(row.succeededAt) })), reversals: rows.reversals.map((row) => ({ ...row, driverName: name(drivers, row.driverId), createdAt: row.createdAt.toISOString() })), blockedStatements: rows.blockedStatements.map((row) => ({ ...row, driverName: name(drivers, row.driverId), merchantName: name(merchants, row.merchantId), nextAttemptAt: iso(row.nextAttemptAt) })), deadLetters: rows.deadLetters.map((row) => ({ ...row, receivedAt: row.receivedAt.toISOString() })) }
  }
}
