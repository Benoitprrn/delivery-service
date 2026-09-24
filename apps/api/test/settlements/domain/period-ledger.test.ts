import { describe, expect, it } from 'vitest'
import { DuplicateSettleableOrderError, InvalidAmountError, buildPeriodLedger } from '../../../src/modules/settlements/public.js'

const at = (value: string) => new Date(value)
const order = (over: Partial<Parameters<typeof buildPeriodLedger>[0]['orders'][number]> = {}) => ({
  orderId: 'o-1', merchantId: 'merchant-a', driverId: 'driver-a', deliveryCents: 600, serviceFeeCents: 120, pricingRuleVersion: 3,
  finalStatus: 'COMPLETED' as const, createdAt: at('2026-09-15T08:00:00Z'), finalizedAt: at('2026-09-15T12:00:00Z'), ...over
})

describe('buildPeriodLedger', () => {
  it('copies frozen order amounts and aggregates the additive two-order example', () => {
    const ledger = buildPeriodLedger({ orders: [order(), order({ orderId: 'o-2', deliveryCents: 400, serviceFeeCents: 80 })] })

    expect(ledger).toMatchObject({ linesCount: 2, merchantAmountCents: 1_200, driverAmountCents: 1_000, serviceFeeCents: 200, dueCents: 1_000 })
    expect(ledger.merchantSettlements).toMatchObject([{
      merchantId: 'merchant-a', amountCents: 1_200, driverAmountCents: 1_000, serviceFeeCents: 200,
      statements: [{ driverId: 'driver-a', dueCents: 1_000 }]
    }])
    expect(ledger.merchantSettlements[0]?.statements[0]?.lines).toMatchObject([
      { orderId: 'o-1', deliveryCents: 600, serviceFeeCents: 120, pricingRuleVersion: 3 },
      { orderId: 'o-2', deliveryCents: 400, serviceFeeCents: 80, pricingRuleVersion: 3 }
    ])
  })

  it('keeps merchants and drivers independent and is deterministic', () => {
    const orders = [
      order({ orderId: 'a2', merchantId: 'merchant-a', driverId: 'driver-b', deliveryCents: 400, serviceFeeCents: 80 }),
      order({ orderId: 'b1', merchantId: 'merchant-b', deliveryCents: 700, serviceFeeCents: 140 }),
      order({ orderId: 'a1', deliveryCents: 600, serviceFeeCents: 120 })
    ]
    const ledger = buildPeriodLedger({ orders })
    expect(ledger.merchantSettlements).toMatchObject([
      { merchantId: 'merchant-a', amountCents: 1_200, driverAmountCents: 1_000, serviceFeeCents: 200, statements: [{ driverId: 'driver-a', dueCents: 600 }, { driverId: 'driver-b', dueCents: 400 }] },
      { merchantId: 'merchant-b', amountCents: 840, driverAmountCents: 700, serviceFeeCents: 140, statements: [{ driverId: 'driver-a', dueCents: 700 }] }
    ])
    expect(buildPeriodLedger({ orders: [...orders].reverse() })).toEqual(ledger)
  })

  it('rejects duplicate orders and invalid frozen amounts', () => {
    expect(() => buildPeriodLedger({ orders: [order(), order()] })).toThrow(DuplicateSettleableOrderError)
    expect(() => buildPeriodLedger({ orders: [order({ deliveryCents: -1 })] })).toThrow(InvalidAmountError)
    expect(() => buildPeriodLedger({ orders: [order({ serviceFeeCents: 1.5 })] })).toThrow(InvalidAmountError)
    expect(() => buildPeriodLedger({ orders: [order({ pricingRuleVersion: 0 })] })).toThrow(InvalidAmountError)
  })
})
