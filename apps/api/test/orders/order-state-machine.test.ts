import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  type OrderStatus
} from '../../src/modules/orders/public.js'

const orderStatuses: readonly OrderStatus[] = [
  'CREATED',
  'AVAILABLE',
  'ASSIGNED',
  'COLLECTED',
  'COMPLETED',
  'CANCELLED',
  'RETURNING',
  'RETURNED'
]

describe('order state machine', () => {
  it.each([
    ['CREATED', 'AVAILABLE'],
    ['CREATED', 'CANCELLED'],
    ['AVAILABLE', 'ASSIGNED'],
    ['AVAILABLE', 'CANCELLED'],
    ['ASSIGNED', 'COLLECTED'],
    ['ASSIGNED', 'AVAILABLE'],
    ['COLLECTED', 'COMPLETED'],
    ['COLLECTED', 'RETURNING'],
    ['RETURNING', 'RETURNED']
  ] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[])(
    'allows %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(true)
      expect(() => assertTransition(from, to)).not.toThrow()
    }
  )

  it.each([
    ['CREATED', 'ASSIGNED'],
    ['AVAILABLE', 'COLLECTED'],
    ['ASSIGNED', 'CANCELLED'],
    ['COLLECTED', 'CANCELLED'],
    ['RETURNING', 'COMPLETED']
  ] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[])(
    'rejects %s -> %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(false)
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError)
    }
  )

  it.each(['COMPLETED', 'CANCELLED', 'RETURNED'] as const satisfies readonly OrderStatus[])(
    'does not allow an outgoing transition from terminal %s',
    from => {
      for (const to of orderStatuses) {
        expect(canTransition(from, to)).toBe(false)
        expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError)
      }
    }
  )
})
