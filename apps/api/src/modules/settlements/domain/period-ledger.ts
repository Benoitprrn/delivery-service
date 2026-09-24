import { DuplicateSettleableOrderError, InvalidAmountError, NotSettleableOrderError } from './errors.js'

export type SettleableOrderInput = {
  orderId: string
  merchantId: string
  driverId: string
  deliveryCents: number
  serviceFeeCents: number
  pricingRuleVersion: number
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
  deliveryCents: number
  serviceFeeCents: number
  pricingRuleVersion: number
}

export type StatementDraft = { driverId: string; merchantId: string; dueCents: number; lines: LedgerLine[] }
export type MerchantSettlementDraft = { merchantId: string; amountCents: number; driverAmountCents: number; serviceFeeCents: number; statements: StatementDraft[] }
export type PeriodLedger = { merchantSettlements: MerchantSettlementDraft[]; linesCount: number; merchantAmountCents: number; driverAmountCents: number; serviceFeeCents: number; dueCents: number }

function assertNonEmptyId(id: string): void {
  if (id.trim().length === 0) throw new NotSettleableOrderError()
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new InvalidAmountError()
}

function compareLines(left: LedgerLine, right: LedgerLine): number {
  return left.finalizedAt.getTime() - right.finalizedAt.getTime() || left.orderId.localeCompare(right.orderId)
}

export function buildPeriodLedger(input: { orders: readonly SettleableOrderInput[] }): PeriodLedger {
  const { orders } = input

  const seenOrderIds = new Set<string>()
  const settlements = new Map<string, { amountCents: number; driverAmountCents: number; serviceFeeCents: number; statements: Map<string, StatementDraft> }>()
  let merchantAmountCents = 0
  let driverAmountCents = 0
  let serviceFeeCents = 0
  let dueCents = 0

  for (const order of orders) {
    assertNonEmptyId(order.orderId); assertNonEmptyId(order.merchantId); assertNonEmptyId(order.driverId)
    if (order.finalStatus !== 'COMPLETED' && order.finalStatus !== 'RETURNED') throw new NotSettleableOrderError()
    assertAmount(order.deliveryCents); assertAmount(order.serviceFeeCents)
    if (!Number.isSafeInteger(order.pricingRuleVersion) || order.pricingRuleVersion < 1) throw new InvalidAmountError('Pricing rule version must be an integer of at least one')
    if (seenOrderIds.has(order.orderId)) throw new DuplicateSettleableOrderError()
    seenOrderIds.add(order.orderId)

    const line: LedgerLine = {
      orderId: order.orderId, merchantId: order.merchantId, driverId: order.driverId, finalStatus: order.finalStatus,
      createdAt: order.createdAt, finalizedAt: order.finalizedAt, deliveryCents: order.deliveryCents,
      serviceFeeCents: order.serviceFeeCents, pricingRuleVersion: order.pricingRuleVersion,
    }
    let settlement = settlements.get(order.merchantId)
    if (settlement === undefined) {
      settlement = { amountCents: 0, driverAmountCents: 0, serviceFeeCents: 0, statements: new Map() }
      settlements.set(order.merchantId, settlement)
    }
    settlement.amountCents += order.deliveryCents + order.serviceFeeCents
    settlement.driverAmountCents += order.deliveryCents
    settlement.serviceFeeCents += order.serviceFeeCents
    let statement = settlement.statements.get(order.driverId)
    if (statement === undefined) {
      statement = { driverId: order.driverId, merchantId: order.merchantId, dueCents: 0, lines: [] }
      settlement.statements.set(order.driverId, statement)
    }
    statement.dueCents += order.deliveryCents
    statement.lines.push(line)
    merchantAmountCents += order.deliveryCents + order.serviceFeeCents
    driverAmountCents += order.deliveryCents
    serviceFeeCents += order.serviceFeeCents
    dueCents += order.deliveryCents
  }

  const merchantSettlements = [...settlements.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([merchantId, settlement]) => ({
      merchantId,
      amountCents: settlement.amountCents,
      driverAmountCents: settlement.driverAmountCents,
      serviceFeeCents: settlement.serviceFeeCents,
      statements: [...settlement.statements.values()]
        .sort((left, right) => left.driverId.localeCompare(right.driverId))
        .map((statement) => ({ ...statement, lines: [...statement.lines].sort(compareLines) })),
    }))

  return { merchantSettlements, linesCount: orders.length, merchantAmountCents, driverAmountCents, serviceFeeCents, dueCents }
}
