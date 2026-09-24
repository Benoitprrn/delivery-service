import { describe, expect, it } from 'vitest'
import { compareDebitAttempt, compareDriverBalance, compareServiceRefund, compareStripeTransferOrphan, compareTransfer } from '../../../src/modules/settlements/public.js'

const debitDb = { id: 'da', status: 'succeeded' as const, amountCents: 100, paymentIntentId: 'pi', chargeId: 'ch', livemode: false, ageMinutes: 0 }
const debitStripe = { paymentIntentId: 'pi', paymentIntentStatus: 'succeeded', chargeId: 'ch', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, amountCents: 100, currency: 'eur', livemode: false, disputed: false, amountRefundedCents: 0 }
const transferDb = { id: 'dt', status: 'succeeded' as const, amountCents: 100, stripeTransferId: 'tr', destinationAccountId: 'acct', chargeId: 'ch', livemode: false, ageMinutes: 0 }
const transferStripe = { transferId: 'tr', amountCents: 100, currency: 'eur', destinationAccountId: 'acct', sourceTransactionId: 'ch', amountReversedCents: 0, livemode: false }
const kinds = (findings: { kind: string }[]) => findings.map((finding) => finding.kind)

describe('settlement reconciliation', () => {
  it('reports debit integrity mismatches as technical, never as restaurant incidents', () => {
    const findings = compareDebitAttempt({ ...debitDb, chargeId: 'other' }, { ...debitStripe, amountCents: 101, currency: 'usd', livemode: true })
    expect(kinds(findings)).toEqual(['debit_amount_mismatch', 'debit_currency_mismatch', 'debit_livemode_mismatch', 'debit_charge_mismatch'])
    expect(findings.every((finding) => finding.scope === 'locadely_technical')).toBe(true)
  })
  it('distinguishes restaurant debit incidents from technical state disagreement', () => {
    expect(compareDebitAttempt(debitDb, { ...debitStripe, paymentIntentStatus: 'requires_payment_method', chargeStatus: 'failed', paid: false, hasBalanceTransaction: false })).toMatchObject([{ kind: 'debit_succeeded_but_not_at_stripe', scope: 'restaurant' }])
    expect(kinds(compareDebitAttempt(debitDb, { ...debitStripe, disputed: true, amountRefundedCents: 2 }))).toEqual(['debit_disputed_after_success', 'debit_refunded_after_success'])
    expect(compareDebitAttempt(debitDb, null)).toMatchObject([{ kind: 'debit_missing_at_stripe', scope: 'locadely_technical' }])
    expect(compareDebitAttempt(debitDb, { ...debitStripe, amountRefundedCents: 200 }, { knownServiceRefundCents: 200 })).toEqual([])
    expect(compareDebitAttempt(debitDb, { ...debitStripe, amountRefundedCents: 250 }, { knownServiceRefundCents: 200 })).toMatchObject([{ kind: 'debit_refunded_after_success', actualCents: 50 }])
  })
  it('treats service-refund reconciliation disagreements as Locadely technical findings', () => {
    const db = { id: 'sr', status: 'succeeded' as const, stripeRefundId: 're', chargeId: 'ch', refundCents: 20, livemode: false }
    expect(compareServiceRefund(db, { refundId: 're', chargeId: 'ch', amountCents: 20, currency: 'eur', status: 'succeeded' })).toEqual([])
    expect(compareServiceRefund(db, null)).toMatchObject([{ scope: 'locadely_technical', kind: 'service_refund_missing_at_stripe' }])
  })
  it('detects stale and failed-local debit states, with no finding when snapshots agree', () => {
    expect(compareDebitAttempt({ ...debitDb, status: 'processing', ageMinutes: 31 }, debitStripe)).toMatchObject([{ kind: 'debit_stale' }])
    expect(compareDebitAttempt({ ...debitDb, status: 'failed' }, debitStripe)).toMatchObject([{ kind: 'debit_failed_but_succeeded_at_stripe' }])
    expect(compareDebitAttempt(debitDb, debitStripe)).toEqual([])
  })
  it('reports all transfer data and ledger discrepancies as technical in deterministic order', () => {
    const findings = compareTransfer({ ...transferDb, destinationAccountId: 'other', chargeId: 'other', livemode: true }, { ...transferStripe, amountCents: 101, currency: 'usd', amountReversedCents: 2 }, 1)
    expect(kinds(findings)).toEqual(['transfer_amount_mismatch', 'transfer_destination_mismatch', 'transfer_source_mismatch', 'transfer_livemode_mismatch', 'transfer_currency_mismatch', 'transfer_reversal_ledger_mismatch'])
    expect(findings.every((finding) => finding.scope === 'locadely_technical')).toBe(true)
  })
  it('finds absent, unresolved and wrongly failed transfers', () => {
    expect(kinds(compareTransfer(transferDb, null, 0))).toEqual(['transfer_missing_at_stripe'])
    expect(kinds(compareTransfer({ ...transferDb, status: 'creating', ageMinutes: 31 }, transferStripe, 0))).toEqual(['transfer_unresolved'])
    expect(kinds(compareTransfer({ ...transferDb, status: 'failed' }, transferStripe, 0))).toEqual(['transfer_exists_but_db_failed'])
  })
  it('flags Stripe transfer orphans and negative driver balances only', () => {
    expect(kinds(compareStripeTransferOrphan({ transferId: 'tr', amountCents: 1, driverTransferIdMetadata: null }, true))).toEqual(['stripe_transfer_orphan'])
    expect(kinds(compareStripeTransferOrphan({ transferId: 'tr', amountCents: 1, driverTransferIdMetadata: 'dt' }, true))).toEqual([])
    expect(compareDriverBalance({ driverId: 'd', availableCents: -1, pendingCents: 0, openReceivablesCents: 4 })).toMatchObject([{ kind: 'driver_negative_balance', details: { openReceivablesCents: 4 } }])
    expect(compareDriverBalance({ driverId: 'd', availableCents: 0, pendingCents: 0, openReceivablesCents: 0 })).toEqual([])
  })
})
