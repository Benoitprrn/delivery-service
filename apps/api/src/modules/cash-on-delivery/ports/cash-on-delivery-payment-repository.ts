import type { CashOnDeliveryPaymentStatus } from '../domain/cash-on-delivery-payment-state-machine.js'

export type CashOnDeliveryPayment = { id: string; orderId: string; sessionId: string; merchantId: string; driverId: string; attemptNo: number; stripeAccountId: string; amountCents: number; currency: 'eur'; stripePaymentIntentId: string | null; stripeChargeId: string | null; status: CashOnDeliveryPaymentStatus; captureIdempotencyKey: string; createIdempotencyKey: string; readerType: 'simulated_bluetooth' | 'bluetooth' | 'usb' | 'internet'; readerSerial: string | null; terminalLocationId: string; failureCode: string | null; declineCode: string | null }
export type CreateCashOnDeliveryPayment = Omit<CashOnDeliveryPayment, 'attemptNo' | 'stripePaymentIntentId' | 'stripeChargeId' | 'failureCode' | 'declineCode'>
export interface CashOnDeliveryPaymentRepository {
  createAttempt(input: CreateCashOnDeliveryPayment): Promise<CashOnDeliveryPayment>
  findByOrderId(orderId: string): Promise<CashOnDeliveryPayment | null>
  findByPaymentIntentId(paymentIntentId: string): Promise<CashOnDeliveryPayment | null>
  transition(input: { id: string; from: readonly CashOnDeliveryPaymentStatus[]; to: CashOnDeliveryPaymentStatus; stripePaymentIntentId?: string; stripeChargeId?: string; failureCode?: string | null; declineCode?: string | null }): Promise<CashOnDeliveryPayment>
}
