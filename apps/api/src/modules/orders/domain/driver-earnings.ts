/** Wallet-only view. Earnings are deliberately not exposed on the general Order DTO. */
export type DriverEarnings = {
  totalEarningCents: number
  completedOrderCount: number
  currency: 'EUR'
  paymentMethod: 'bank_transfer'
  paymentStatus: 'provisional'
  recentCompletedOrders: DriverCompletedOrderEarning[]
}

export type DriverCompletedOrderEarning = {
  id: string
  completedAt: Date
  earningCents: number
  deliveryAddress: string
}
