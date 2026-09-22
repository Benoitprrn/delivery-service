import Stripe from 'stripe'
import type { StripeDebitSnapshot, StripeTransferSnapshot } from '../domain/reconciliation.js'
import type { ReconciliationStripeReader } from '../ports/settlement-ops.js'

const missing = (error: unknown): boolean => error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing'

/** Lectures Stripe de la réconciliation : uniquement des lectures ; « introuvable » = `null`, toute autre erreur est remontée (l'objet n'est alors pas déclaré examiné). */
export class StripeReconciliationReader implements ReconciliationStripeReader {
  public constructor(private readonly stripe: Stripe) {}

  public async readDebit(paymentIntentId: string): Promise<StripeDebitSnapshot | null> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge.balance_transaction'] })
      const charge = typeof intent.latest_charge === 'object' && intent.latest_charge !== null ? intent.latest_charge : null
      return {
        paymentIntentId: intent.id, paymentIntentStatus: intent.status, chargeId: charge?.id ?? (typeof intent.latest_charge === 'string' ? intent.latest_charge : null), chargeStatus: charge?.status ?? null,
        paid: charge?.paid ?? false, hasBalanceTransaction: (charge?.balance_transaction ?? null) !== null, amountCents: intent.amount, currency: intent.currency, livemode: intent.livemode,
        disputed: charge?.disputed ?? false, amountRefundedCents: charge?.amount_refunded ?? 0
      }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  public async readTransfer(transferId: string): Promise<StripeTransferSnapshot | null> {
    try {
      const transfer = await this.stripe.transfers.retrieve(transferId)
      return {
        transferId: transfer.id, amountCents: transfer.amount, currency: transfer.currency,
        destinationAccountId: typeof transfer.destination === 'string' ? transfer.destination : transfer.destination?.id ?? null,
        sourceTransactionId: typeof transfer.source_transaction === 'string' ? transfer.source_transaction : transfer.source_transaction?.id ?? null,
        amountReversedCents: transfer.amount_reversed, livemode: transfer.livemode
      }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  public async readTransferOrigin(transferId: string): Promise<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null } | null> {
    try {
      const transfer = await this.stripe.transfers.retrieve(transferId)
      return { transferId: transfer.id, amountCents: transfer.amount, driverTransferIdMetadata: transfer.metadata?.driver_transfer_id ?? null }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  public async listRecentTransfers(sinceUnixSeconds: number): Promise<Array<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null }>> {
    const out: Array<{ transferId: string; amountCents: number; driverTransferIdMetadata: string | null }> = []
    for await (const transfer of this.stripe.transfers.list({ created: { gte: sinceUnixSeconds }, limit: 100 })) {
      out.push({ transferId: transfer.id, amountCents: transfer.amount, driverTransferIdMetadata: transfer.metadata?.driver_transfer_id ?? null })
      if (out.length >= 1000) break
    }
    return out
  }

  public async readDriverBalance(accountId: string): Promise<{ availableCents: number; pendingCents: number } | null> {
    try {
      const balance = await this.stripe.balance.retrieve({}, { stripeAccount: accountId })
      const eur = (entries: Array<{ amount: number; currency: string }>): number => entries.filter((entry) => entry.currency === 'eur').reduce((total, entry) => total + entry.amount, 0)
      return { availableCents: eur(balance.available), pendingCents: eur(balance.pending) }
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  public async listPayouts(accountId: string, sinceUnixSeconds: number): Promise<Array<{ payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null }>> {
    const out: Array<{ payoutId: string; amountCents: number; status: string; automatic: boolean; arrivalDate: string | null }> = []
    for await (const payout of this.stripe.payouts.list({ created: { gte: sinceUnixSeconds }, limit: 100 }, { stripeAccount: accountId })) {
      out.push({ payoutId: payout.id, amountCents: payout.amount, status: payout.status, automatic: payout.automatic, arrivalDate: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10) })
      if (out.length >= 200) break
    }
    return out
  }
}
