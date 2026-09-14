// Source de vérité des transitions : docs/adr/0001-order-states.md.
export type OrderStatus =
  | 'CREATED'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'COLLECTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'RETURNING'
  | 'RETURNED'

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['AVAILABLE', 'CANCELLED'],
  AVAILABLE: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['COLLECTED', 'AVAILABLE'],
  COLLECTED: ['COMPLETED', 'RETURNING'],
  COMPLETED: [],
  CANCELLED: [],
  RETURNING: ['RETURNED'],
  RETURNED: []
}
