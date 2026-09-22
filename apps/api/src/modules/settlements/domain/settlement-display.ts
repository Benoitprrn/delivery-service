import type { StatementStatus } from './statement-status.js'
import type { DriverDisplayState, MerchantDisplayState } from './settlement-views.js'
import type { DebitAttemptStatus, MerchantSettlementRow } from '../ports/settlement-read.js'

export function driverStatementDisplayState(input: { status: StatementStatus; dueCents: number; paidCents: number; holdReason: string | null; settlementStatus: string; debit: { status: DebitAttemptStatus } | null; incidentOpen: boolean }): DriverDisplayState {
  if (input.dueCents > 0 && input.paidCents >= input.dueCents) return 'sent_to_account'
  if (input.status === 'blocked_driver_account') return 'account_action_required'
  // Un hold technique reste à charge Locadely, même si une donnée incidente existe par ailleurs.
  if (input.settlementStatus === 'technical_hold') return 'awaiting_debit'
  if (input.incidentOpen || input.holdReason === 'debit_incident') return 'restaurant_incident'
  if (input.status === 'unpaid_restaurant') return 'awaiting_restaurant_payment'
  if (input.paidCents > 0) return 'payment_delayed'
  if (input.status === 'succeeded_held') return input.holdReason !== null ? 'payment_delayed' : 'collected_payment_scheduled'
  if (input.status === 'waiting_sepa' || input.status === 'unpaid') return input.debit?.status === 'creating' || input.debit?.status === 'processing' ? 'debit_in_progress' : 'awaiting_debit'
  return 'awaiting_debit'
}

export type DriverPeriodTotals = { totalCents: number; sentCents: number; pendingCents: number; unpaidByRestaurantCents: number }

export function summarizeDriverPeriod(statements: readonly { dueCents: number; paidCents: number; displayState: DriverDisplayState }[]): DriverPeriodTotals {
  return statements.reduce<DriverPeriodTotals>((totals, statement) => {
    const remainingCents = statement.dueCents - statement.paidCents
    return {
      totalCents: totals.totalCents + statement.dueCents,
      sentCents: totals.sentCents + statement.paidCents,
      pendingCents: totals.pendingCents + remainingCents,
      unpaidByRestaurantCents: totals.unpaidByRestaurantCents + (statement.displayState === 'awaiting_restaurant_payment' || statement.displayState === 'restaurant_incident' ? remainingCents : 0)
    }
  }, { totalCents: 0, sentCents: 0, pendingCents: 0, unpaidByRestaurantCents: 0 })
}

export function sumTotals(periods: readonly DriverPeriodTotals[]): DriverPeriodTotals {
  return periods.reduce<DriverPeriodTotals>((totals, period) => ({ totalCents: totals.totalCents + period.totalCents, sentCents: totals.sentCents + period.sentCents, pendingCents: totals.pendingCents + period.pendingCents, unpaidByRestaurantCents: totals.unpaidByRestaurantCents + period.unpaidByRestaurantCents }), { totalCents: 0, sentCents: 0, pendingCents: 0, unpaidByRestaurantCents: 0 })
}

export function expectedPaymentAt(displayState: DriverDisplayState, payrunAt: Date | null): string | null {
  return payrunAt !== null && ['awaiting_debit', 'debit_in_progress', 'collected_payment_scheduled', 'payment_delayed'].includes(displayState) ? payrunAt.toISOString() : null
}

export function merchantDisplayState(row: MerchantSettlementRow): MerchantDisplayState {
  if (row.incidents.some((incident) => incident.status === 'open' || incident.status === 'lost' || incident.kind === 'refund')) return 'incident'
  if (row.retryRequested) return 'retry_scheduled'
  if (row.status === 'succeeded') return 'paid'
  if (row.status === 'failed') return 'failed'
  if (row.status === 'technical_hold') return 'technical_review'
  if (row.status === 'debit_scheduled' || row.status === 'debit_processing') return 'debit_in_progress'
  if (row.status === 'notified') return 'notified'
  return 'awaiting_notification'
}

export function merchantAttemptOutcome(status: DebitAttemptStatus): 'in_progress' | 'succeeded' | 'failed' | 'technical' {
  if (status === 'creating' || status === 'processing') return 'in_progress'
  if (status === 'succeeded') return 'succeeded'
  if (status === 'failed' || status === 'canceled') return 'failed'
  return 'technical'
}

export function incidentOpenCents(incidents: MerchantSettlementRow['incidents']): number {
  return incidents.reduce((total, incident) => total + (incident.status === 'open' || incident.status === 'lost' || incident.kind === 'refund' ? incident.amountCents : 0), 0)
}
