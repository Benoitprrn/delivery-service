import { latestClosableMonday } from '../domain/closing-schedule.js'
import { computeLineFee } from '../domain/fees.js'
import { addCalendarDays } from '../domain/local-date.js'
import { parisLocalTimeToUtc, parisWeekBounds } from '../domain/paris-time.js'
import type { DriverSettlementsResponse } from '../domain/settlement-views.js'
import type { SettleableOrdersReader, SettlementSettings } from '../ports/settlement-close.js'

export interface CurrentWeekEstimator { estimate(driverId: string, now: Date): Promise<DriverSettlementsResponse['currentWeek']> }

export class OrdersCurrentWeekEstimator implements CurrentWeekEstimator {
  public constructor(private readonly readSettings: () => Promise<SettlementSettings>, private readonly orders: SettleableOrdersReader) {}

  public async estimate(driverId: string, now: Date): Promise<DriverSettlementsResponse['currentWeek']> {
    const settings = await this.readSettings()
    if (settings.goLiveAt === null) return null
    const monday = latestClosableMonday(now)
    const bounds = parisWeekBounds(monday)
    const orders = await this.orders.listSettleableOrders({ finalizedFrom: bounds.startUtc, finalizedTo: bounds.endUtc, createdNotBefore: settings.goLiveAt })
    const deliveries = orders.filter((order) => order.driverId === driverId)
    if (deliveries.length === 0) return null
    const estimatedNetCents = deliveries.reduce((total, order) => total + order.driverEarningCents - computeLineFee({ earningCents: order.driverEarningCents, feeRateBps: settings.feeRateBps }).feeCents, 0)
    return { periodStart: bounds.startUtc.toISOString(), periodEnd: bounds.endUtc.toISOString(), deliveries: deliveries.length, estimatedNetCents, closesAt: parisLocalTimeToUtc(addCalendarDays(monday, 7), 0, 5).toISOString() }
  }
}
