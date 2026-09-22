import { describe, expect, it } from 'vitest'
import { buildPeriodLedger, DuplicateSettleableOrderError, InvalidAmountError, NotSettleableOrderError } from '../../../src/modules/settlements/public.js'

const at = (value: string): Date => new Date(value)
const orders = [
  { orderId: 'o-3', merchantId: 'merchant-b', driverId: 'driver-a', driverEarningCents: 909, merchantPriceCents: 1_800, finalStatus: 'RETURNED' as const, createdAt: at('2026-09-16T08:00:00Z'), finalizedAt: at('2026-09-16T12:00:00Z') },
  { orderId: 'o-1', merchantId: 'merchant-a', driverId: 'driver-b', driverEarningCents: 401, merchantPriceCents: 1_000, finalStatus: 'COMPLETED' as const, createdAt: at('2026-09-14T08:00:00Z'), finalizedAt: at('2026-09-14T12:00:00Z') },
  { orderId: 'o-2', merchantId: 'merchant-a', driverId: 'driver-a', driverEarningCents: 475, merchantPriceCents: 1_200, finalStatus: 'COMPLETED' as const, createdAt: at('2026-09-15T08:00:00Z'), finalizedAt: at('2026-09-15T12:00:00Z') },
  { orderId: 'o-4', merchantId: 'merchant-a', driverId: 'driver-a', driverEarningCents: 401, merchantPriceCents: 900, finalStatus: 'COMPLETED' as const, createdAt: at('2026-09-16T08:00:00Z'), finalizedAt: at('2026-09-15T12:00:00Z') },
]

describe('period ledger', () => {
  it('calculates fees per line and separates merchant prices from driver earnings', () => {
    const ledger = buildPeriodLedger({ orders, feeRateBps: 2_000, feeRuleVersion: 3 })
    // 401/475/909 => 80/95/181 (356); the fourth 401 adds 80, for 436 cents of fees.
    expect(ledger).toMatchObject({ linesCount: 4, merchantAmountCents: 4_900, grossCents: 2_186, feeCents: 436, dueCents: 1_750 })
    expect(ledger.merchantSettlements.flatMap((settlement) => settlement.statements.flatMap((statement) => statement.lines)).filter((line) => ['o-1', 'o-2', 'o-3'].includes(line.orderId)).map((line) => line.feeCents).sort((left, right) => left - right)).toEqual([80, 95, 181])
    expect(ledger.merchantSettlements.map(({ merchantId, amountCents }) => ({ merchantId, amountCents }))).toEqual([
      { merchantId: 'merchant-a', amountCents: 3_100 }, { merchantId: 'merchant-b', amountCents: 1_800 },
    ])
    expect(ledger.merchantSettlements[0]!.statements.map(({ driverId, grossCents, feeCents, dueCents }) => ({ driverId, grossCents, feeCents, dueCents }))).toEqual([
      { driverId: 'driver-a', grossCents: 876, feeCents: 175, dueCents: 701 }, { driverId: 'driver-b', grossCents: 401, feeCents: 80, dueCents: 321 },
    ])
  })

  it('keeps returned orders payable and orders every output deterministically', () => {
    const ledger = buildPeriodLedger({ orders: [...orders].reverse(), feeRateBps: 2_000, feeRuleVersion: 3 })
    expect(ledger.merchantSettlements[0]!.statements[0]!.lines.map((line) => line.orderId)).toEqual(['o-2', 'o-4'])
    expect(ledger.merchantSettlements[1]!.statements[0]!.lines[0]!.finalStatus).toBe('RETURNED')
    expect(ledger).toEqual(buildPeriodLedger({ orders, feeRateBps: 2_000, feeRuleVersion: 3 }))
  })

  it('returns an empty ledger for no orders', () => expect(buildPeriodLedger({ orders: [], feeRateBps: 2_000, feeRuleVersion: 1 })).toEqual({ merchantSettlements: [], linesCount: 0, merchantAmountCents: 0, grossCents: 0, feeCents: 0, dueCents: 0 }))
  it('does not mutate the input orders', () => {
    const input = [...orders]
    buildPeriodLedger({ orders: input, feeRateBps: 2_000, feeRuleVersion: 1 })
    expect(input).toEqual(orders)
  })
  it('rejects duplicate order ids', () => expect(() => buildPeriodLedger({ orders: [orders[0]!, orders[0]!], feeRateBps: 2_000, feeRuleVersion: 1 })).toThrow(DuplicateSettleableOrderError))
  it.each([{ orders: [{ ...orders[0]!, driverEarningCents: -1 }] }, { orders: [{ ...orders[0]!, merchantPriceCents: 1.5 }] }])('rejects invalid amounts', ({ orders: invalidOrders }) => expect(() => buildPeriodLedger({ orders: invalidOrders, feeRateBps: 2_000, feeRuleVersion: 1 })).toThrow(InvalidAmountError))
  it.each([{ orders: [{ ...orders[0]!, orderId: '' }] }, { orders: [{ ...orders[0]!, finalStatus: 'CANCELLED' as never }] }])('rejects non-settleable orders', ({ orders: invalidOrders }) => expect(() => buildPeriodLedger({ orders: invalidOrders, feeRateBps: 2_000, feeRuleVersion: 1 })).toThrow(NotSettleableOrderError))
  it.each([{ feeRateBps: -1, feeRuleVersion: 1 }, { feeRateBps: 2_000, feeRuleVersion: 0 }])('rejects invalid fee rules', ({ feeRateBps, feeRuleVersion }) => expect(() => buildPeriodLedger({ orders, feeRateBps, feeRuleVersion })).toThrow(InvalidAmountError))
})
