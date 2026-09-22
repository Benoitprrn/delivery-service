import { InvalidAmountError } from './errors.js'

export type FindingScope = 'restaurant' | 'locadely_technical'
export type ReconciliationFinding = { kind: string; scope: FindingScope; refType: 'debit_attempt' | 'driver_transfer' | 'driver_transfer_reversal' | 'driver_balance' | 'stripe_orphan'; refId: string; expectedCents: number | null; actualCents: number | null; details: Record<string, string | number | boolean | null> }
export type DebitAttemptSnapshot = { id: string; status: 'creating' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'technical_error'; amountCents: number; paymentIntentId: string | null; chargeId: string | null; livemode: boolean; ageMinutes: number }
export type StripeDebitSnapshot = { paymentIntentId: string; paymentIntentStatus: string; chargeId: string | null; chargeStatus: string | null; paid: boolean; hasBalanceTransaction: boolean; amountCents: number; currency: string; livemode: boolean; disputed: boolean; amountRefundedCents: number }
export type DriverTransferSnapshot = { id: string; status: 'creating' | 'succeeded' | 'failed' | 'unknown'; amountCents: number; stripeTransferId: string | null; destinationAccountId: string | null; chargeId: string; livemode: boolean; ageMinutes: number }
export type StripeTransferSnapshot = { transferId: string; amountCents: number; currency: string; destinationAccountId: string | null; sourceTransactionId: string | null; amountReversedCents: number; livemode: boolean }

function integer(value: number): void { if (!Number.isSafeInteger(value)) throw new InvalidAmountError() }
function nonNegative(value: number): void { integer(value); if (value < 0) throw new InvalidAmountError() }
function finding(kind: string, scope: FindingScope, refType: ReconciliationFinding['refType'], refId: string, expectedCents: number | null, actualCents: number | null, details: ReconciliationFinding['details'] = {}): ReconciliationFinding { return { kind, scope, refType, refId, expectedCents, actualCents, details } }
function terminal(status: string): boolean { return status === 'succeeded' || status === 'failed' }
function stripeSucceeded(stripe: StripeDebitSnapshot): boolean { return stripe.paymentIntentStatus === 'succeeded' && stripe.chargeStatus === 'succeeded' && stripe.paid && stripe.hasBalanceTransaction }

export function compareDebitAttempt(db: DebitAttemptSnapshot, stripe: StripeDebitSnapshot | null, opts: { staleAfterMinutes?: number } = {}): ReconciliationFinding[] {
  nonNegative(db.amountCents); nonNegative(db.ageMinutes)
  const staleAfterMinutes = opts.staleAfterMinutes ?? 30; nonNegative(staleAfterMinutes)
  if (stripe === null) return (db.paymentIntentId !== null || db.status === 'processing' || db.status === 'succeeded') ? [finding('debit_missing_at_stripe', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, null)] : []
  nonNegative(stripe.amountCents); nonNegative(stripe.amountRefundedCents)
  const results: ReconciliationFinding[] = []
  if (db.amountCents !== stripe.amountCents) results.push(finding('debit_amount_mismatch', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if (stripe.currency.toLowerCase() !== 'eur') results.push(finding('debit_currency_mismatch', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents, { expectedCurrency: 'eur', actualCurrency: stripe.currency }))
  if (db.livemode !== stripe.livemode) results.push(finding('debit_livemode_mismatch', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if (db.chargeId !== null && stripe.chargeId !== null && db.chargeId !== stripe.chargeId) results.push(finding('debit_charge_mismatch', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if (db.status === 'succeeded' && !stripeSucceeded(stripe)) {
    const restaurant = stripe.paymentIntentStatus === 'requires_payment_method' || stripe.chargeStatus === 'failed'
    results.push(finding('debit_succeeded_but_not_at_stripe', restaurant ? 'restaurant' : 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  }
  if (db.status === 'succeeded' && stripe.disputed) results.push(finding('debit_disputed_after_success', 'restaurant', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if (db.status === 'succeeded' && stripe.amountRefundedCents > 0) results.push(finding('debit_refunded_after_success', 'restaurant', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if ((db.status === 'creating' || db.status === 'processing') && db.ageMinutes > staleAfterMinutes && terminal(stripe.paymentIntentStatus)) results.push(finding('debit_stale', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  if ((db.status === 'failed' || db.status === 'technical_error') && stripeSucceeded(stripe)) results.push(finding('debit_failed_but_succeeded_at_stripe', 'locadely_technical', 'debit_attempt', db.id, db.amountCents, stripe.amountCents))
  return results
}

export function compareTransfer(db: DriverTransferSnapshot, stripe: StripeTransferSnapshot | null, ledgerReversedCents: number, opts: { staleAfterMinutes?: number } = {}): ReconciliationFinding[] {
  nonNegative(db.amountCents); nonNegative(db.ageMinutes); nonNegative(ledgerReversedCents)
  const staleAfterMinutes = opts.staleAfterMinutes ?? 30; nonNegative(staleAfterMinutes)
  if (stripe === null) return (db.status === 'succeeded' || ((db.status === 'unknown' || db.status === 'creating') && db.stripeTransferId !== null)) ? [finding('transfer_missing_at_stripe', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, null)] : []
  nonNegative(stripe.amountCents); nonNegative(stripe.amountReversedCents)
  const results: ReconciliationFinding[] = []
  if (db.amountCents !== stripe.amountCents) results.push(finding('transfer_amount_mismatch', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, stripe.amountCents))
  if (db.destinationAccountId !== stripe.destinationAccountId) results.push(finding('transfer_destination_mismatch', 'locadely_technical', 'driver_transfer', db.id, null, null))
  if (stripe.sourceTransactionId !== null && stripe.sourceTransactionId !== db.chargeId) results.push(finding('transfer_source_mismatch', 'locadely_technical', 'driver_transfer', db.id, null, null))
  if (db.livemode !== stripe.livemode) results.push(finding('transfer_livemode_mismatch', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, stripe.amountCents))
  if (stripe.currency.toLowerCase() !== 'eur') results.push(finding('transfer_currency_mismatch', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, stripe.amountCents, { expectedCurrency: 'eur', actualCurrency: stripe.currency }))
  if (stripe.amountReversedCents !== ledgerReversedCents) results.push(finding('transfer_reversal_ledger_mismatch', 'locadely_technical', 'driver_transfer', db.id, ledgerReversedCents, stripe.amountReversedCents))
  if ((db.status === 'creating' || db.status === 'unknown') && db.ageMinutes > staleAfterMinutes) results.push(finding('transfer_unresolved', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, stripe.amountCents))
  if (db.status === 'failed') results.push(finding('transfer_exists_but_db_failed', 'locadely_technical', 'driver_transfer', db.id, db.amountCents, stripe.amountCents))
  return results
}

export function compareStripeTransferOrphan(input: { transferId: string; amountCents: number; driverTransferIdMetadata: string | null }, knownInDb: boolean): ReconciliationFinding[] {
  nonNegative(input.amountCents)
  return !knownInDb || input.driverTransferIdMetadata === null ? [finding('stripe_transfer_orphan', 'locadely_technical', 'stripe_orphan', input.transferId, null, input.amountCents)] : []
}

export function compareDriverBalance(input: { driverId: string; availableCents: number; pendingCents: number; openReceivablesCents: number }): ReconciliationFinding[] {
  integer(input.availableCents); integer(input.pendingCents); integer(input.openReceivablesCents)
  return input.availableCents < 0 ? [finding('driver_negative_balance', 'locadely_technical', 'driver_balance', input.driverId, null, input.availableCents, { openReceivablesCents: input.openReceivablesCents })] : []
}
