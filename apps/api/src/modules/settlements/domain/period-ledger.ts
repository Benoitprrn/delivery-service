import { DuplicateSettleableOrderError, InvalidAmountError, NotSettleableOrderError } from './errors.js'
import { computeLineFee } from './fees.js'

export type SettleableOrderInput = {
  orderId: string
  merchantId: string
  driverId: string
  driverEarningCents: number
  merchantPriceCents: number
  finalStatus: 'COMPLETED' | 'RETURNED'
  createdAt: Date
  finalizedAt: Date
}

export type LedgerLine = {
  orderId: string
  merchantId: string
  driverId: string
  finalStatus: 'COMPLETED' | 'RETURNED'
  createdAt: Date
  finalizedAt: Date
  merchantAmountCents: number
  driverEarningCents: number
  feeRateBps: number
  feeRuleVersion: number
  feeCents: number
  netCents: number
}

export type StatementDraft = { driverId: string; merchantId: string; grossCents: number; feeCents: number; dueCents: number; lines: LedgerLine[] }
export type MerchantSettlementDraft = { merchantId: string; amountCents: number; statements: StatementDraft[] }
export type PeriodLedger = { merchantSettlements: MerchantSettlementDraft[]; linesCount: number; merchantAmountCents: number; grossCents: number; feeCents: number; dueCents: number }

function assertNonEmptyId(id: string): void {
  if (id.trim().length === 0) throw new NotSettleableOrderError()
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new InvalidAmountError()
}

function compareLines(left: LedgerLine, right: LedgerLine): number {
  return left.finalizedAt.getTime() - right.finalizedAt.getTime() || left.orderId.localeCompare(right.orderId)
}

export function buildPeriodLedger(input: { orders: readonly SettleableOrderInput[]; feeRateBps: number; feeRuleVersion: number }): PeriodLedger {
  const { orders, feeRateBps, feeRuleVersion } = input
  if (!Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) throw new InvalidAmountError('Fee rate must be an integer from 0 to 10000 bps')
  if (!Number.isSafeInteger(feeRuleVersion) || feeRuleVersion < 1) throw new InvalidAmountError('Fee rule version must be an integer of at least one')

  const seenOrderIds = new Set<string>()
  const settlements = new Map<string, { amountCents: number; statements: Map<string, StatementDraft> }>()
  let merchantAmountCents = 0
  let grossCents = 0
  let feeCents = 0
  let dueCents = 0

  for (const order of orders) {
    assertNonEmptyId(order.orderId); assertNonEmptyId(order.merchantId); assertNonEmptyId(order.driverId)
    if (order.finalStatus !== 'COMPLETED' && order.finalStatus !== 'RETURNED') throw new NotSettleableOrderError()
    assertAmount(order.driverEarningCents); assertAmount(order.merchantPriceCents)
    if (seenOrderIds.has(order.orderId)) throw new DuplicateSettleableOrderError()
    seenOrderIds.add(order.orderId)

    const { feeCents: lineFeeCents, netCents } = computeLineFee({ earningCents: order.driverEarningCents, feeRateBps })
    const line: LedgerLine = {
      orderId: order.orderId, merchantId: order.merchantId, driverId: order.driverId, finalStatus: order.finalStatus,
      createdAt: order.createdAt, finalizedAt: order.finalizedAt, merchantAmountCents: order.merchantPriceCents,
      driverEarningCents: order.driverEarningCents, feeRateBps, feeRuleVersion, feeCents: lineFeeCents, netCents,
    }
    let settlement = settlements.get(order.merchantId)
    if (settlement === undefined) {
      settlement = { amountCents: 0, statements: new Map() }
      settlements.set(order.merchantId, settlement)
    }
    settlement.amountCents += order.merchantPriceCents
    let statement = settlement.statements.get(order.driverId)
    if (statement === undefined) {
      statement = { driverId: order.driverId, merchantId: order.merchantId, grossCents: 0, feeCents: 0, dueCents: 0, lines: [] }
      settlement.statements.set(order.driverId, statement)
    }
    statement.grossCents += order.driverEarningCents
    statement.feeCents += lineFeeCents
    statement.dueCents += netCents
    statement.lines.push(line)
    merchantAmountCents += order.merchantPriceCents
    grossCents += order.driverEarningCents
    feeCents += lineFeeCents
    dueCents += netCents
  }

  const merchantSettlements = [...settlements.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([merchantId, settlement]) => ({
      merchantId,
      amountCents: settlement.amountCents,
      statements: [...settlement.statements.values()]
        .sort((left, right) => left.driverId.localeCompare(right.driverId))
        .map((statement) => ({ ...statement, lines: [...statement.lines].sort(compareLines) })),
    }))

  return { merchantSettlements, linesCount: orders.length, merchantAmountCents, grossCents, feeCents, dueCents }
}
