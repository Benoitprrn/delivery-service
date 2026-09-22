export type ReducedSettlementEvent = { id: string; type: string; accountId: string | null; objectId: string | null; paymentIntentId: string | null; chargeId: string | null; transferId: string | null }

export const SETTLEMENT_WEBHOOK_EVENT_TYPES: readonly string[] = [
  'payment_intent.processing', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'payment_intent.requires_action',
  'charge.pending', 'charge.succeeded', 'charge.failed', 'charge.updated', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated',
  'transfer.created', 'transfer.updated', 'transfer.reversed'
]

export type SettlementEventAction =
  | { action: 'refresh_debit'; paymentIntentId: string | null; chargeId: string | null }
  | { action: 'refresh_incident'; chargeId: string }
  | { action: 'audit_transfer'; transferId: string }
  | { action: 'ignore'; reason: 'unsupported_type' | 'missing_identifier' | 'connect_event' }

function nonEmptyString(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null }
function identifier(value: unknown): string | null {
  const direct = nonEmptyString(value)
  if (direct !== null) return direct
  return value !== null && typeof value === 'object' ? nonEmptyString((value as Record<string, unknown>).id) : null
}

export function reduceStripeEvent(event: { id: string; type: string; account?: string | null; data: { object: Record<string, unknown> } }): ReducedSettlementEvent {
  const object = event.data?.object
  const base: ReducedSettlementEvent = { id: nonEmptyString(event.id) ?? '', type: nonEmptyString(event.type) ?? '', accountId: nonEmptyString(event.account) ?? null, objectId: null, paymentIntentId: null, chargeId: null, transferId: null }
  if (object === null || typeof object !== 'object') return base
  if (event.type.startsWith('payment_intent.')) return { ...base, objectId: identifier(object.id), paymentIntentId: identifier(object.id), chargeId: identifier(object.latest_charge) }
  if (event.type.startsWith('charge.dispute.')) return { ...base, objectId: identifier(object.id), paymentIntentId: identifier(object.payment_intent), chargeId: identifier(object.charge) }
  if (event.type.startsWith('charge.')) return { ...base, objectId: identifier(object.id), paymentIntentId: identifier(object.payment_intent), chargeId: identifier(object.id) }
  if (event.type.startsWith('transfer.')) return { ...base, objectId: identifier(object.id), transferId: identifier(object.id) }
  return base
}

export function triageSettlementEvent(event: ReducedSettlementEvent): SettlementEventAction {
  if (event.accountId !== null) return { action: 'ignore', reason: 'connect_event' }
  if (!SETTLEMENT_WEBHOOK_EVENT_TYPES.includes(event.type)) return { action: 'ignore', reason: 'unsupported_type' }
  if (event.type.startsWith('payment_intent.') || ['charge.pending', 'charge.succeeded', 'charge.failed', 'charge.updated'].includes(event.type)) {
    return event.paymentIntentId !== null || event.chargeId !== null ? { action: 'refresh_debit', paymentIntentId: event.paymentIntentId, chargeId: event.chargeId } : { action: 'ignore', reason: 'missing_identifier' }
  }
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) return event.chargeId === null ? { action: 'ignore', reason: 'missing_identifier' } : { action: 'refresh_incident', chargeId: event.chargeId }
  return event.transferId === null ? { action: 'ignore', reason: 'missing_identifier' } : { action: 'audit_transfer', transferId: event.transferId }
}
