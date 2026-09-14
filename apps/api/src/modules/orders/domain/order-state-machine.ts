import { InvalidTransitionError } from './errors.js'
import { ALLOWED_TRANSITIONS, type OrderStatus } from './order-status.js'

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Transition from ${from} to ${to} is not allowed`)
  }
}
