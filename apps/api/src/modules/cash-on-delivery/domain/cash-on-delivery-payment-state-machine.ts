import { InvalidCashOnDeliveryPaymentTransitionError } from './errors.js'

export type CashOnDeliveryPaymentStatus = 'created' | 'intent_created' | 'processing' | 'authorized' | 'captured' | 'failed' | 'canceled' | 'unknown'
const transitions: Record<CashOnDeliveryPaymentStatus, readonly CashOnDeliveryPaymentStatus[]> = {
  created: ['intent_created', 'failed', 'canceled', 'unknown'], intent_created: ['processing', 'failed', 'canceled', 'unknown'],
  processing: ['authorized', 'failed', 'canceled', 'unknown'], authorized: ['captured', 'failed', 'canceled', 'unknown'],
  captured: [], failed: [], canceled: [], unknown: ['authorized', 'captured', 'failed', 'canceled']
}
export function canTransitionCashOnDeliveryPayment(from: CashOnDeliveryPaymentStatus, to: CashOnDeliveryPaymentStatus): boolean { return transitions[from].includes(to) }
export function assertCashOnDeliveryPaymentTransition(from: CashOnDeliveryPaymentStatus, to: CashOnDeliveryPaymentStatus): void { if (!canTransitionCashOnDeliveryPayment(from, to)) throw new InvalidCashOnDeliveryPaymentTransitionError(`Cash on delivery payment transition from ${from} to ${to} is not allowed`) }
