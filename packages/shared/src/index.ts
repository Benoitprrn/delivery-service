import { z } from 'zod'

export const CASH_ON_DELIVERY_MIN_CENTS = 100
export const CASH_ON_DELIVERY_MAX_CENTS = 50000
export const CASH_ON_DELIVERY_CURRENCY = 'eur' as const

export const cashOnDeliveryInputSchema = z.object({
  amountCents: z.int().min(CASH_ON_DELIVERY_MIN_CENTS).max(CASH_ON_DELIVERY_MAX_CENTS)
}).strict()

export type OrderCashOnDelivery = {
  required: boolean
  amountCents: number | null
  currency: typeof CASH_ON_DELIVERY_CURRENCY | null
  collected: boolean
}
