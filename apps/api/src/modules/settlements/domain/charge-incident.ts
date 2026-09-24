import { InvalidAmountError } from './errors.js'

export type ChargeIncidentView = { chargeId: string; paymentIntentId: string | null; chargeAmountCents: number; amountRefundedCents: number; dispute: { id: string; status: string; amountCents: number; reason: string | null } | null }
export type IncidentKind = 'dispute' | 'refund'
export type IncidentStatus = 'open' | 'won' | 'lost' | 'closed'
export type ChargeIncident = { kind: IncidentKind; externalId: string; amountCents: number; status: IncidentStatus; reason: string | null }
export type ChargeIncidentAssessment = { incidents: ChargeIncident[]; chargeUsable: boolean; restaurantOwedCents: number }

function validAmount(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new InvalidAmountError() }
function disputeStatus(status: string): IncidentStatus {
  if (status === 'won') return 'won'
  if (status === 'lost' || status === 'charge_refunded') return 'lost'
  if (status === 'warning_closed') return 'closed'
  return 'open'
}

export function assessChargeIncidents(view: ChargeIncidentView, knownServiceRefundCents = 0): ChargeIncidentAssessment {
  validAmount(view.chargeAmountCents); validAmount(view.amountRefundedCents)
  validAmount(knownServiceRefundCents)
  if (view.amountRefundedCents > view.chargeAmountCents) throw new InvalidAmountError()
  const unexplainedRefundCents = Math.max(0, view.amountRefundedCents - knownServiceRefundCents)
  const incidents: ChargeIncident[] = []
  const dispute = view.dispute
  if (dispute !== null) { validAmount(dispute.amountCents); incidents.push({ kind: 'dispute', externalId: dispute.id, amountCents: dispute.amountCents, status: disputeStatus(dispute.status), reason: dispute.reason }) }
  if (unexplainedRefundCents > 0 && dispute?.status !== 'charge_refunded') incidents.push({ kind: 'refund', externalId: `refund:${view.chargeId}`, amountCents: unexplainedRefundCents, status: 'lost', reason: null })
  const owed = incidents.reduce((sum, incident) => sum + (incident.kind === 'refund' || incident.status === 'open' || incident.status === 'lost' ? incident.amountCents : 0), 0)
  return { incidents, chargeUsable: !incidents.some((incident) => incident.kind === 'refund' || incident.status === 'open' || incident.status === 'lost'), restaurantOwedCents: Math.max(0, Math.min(view.chargeAmountCents, owed)) }
}
