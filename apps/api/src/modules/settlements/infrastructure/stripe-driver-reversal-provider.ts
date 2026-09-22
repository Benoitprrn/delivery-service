import Stripe from 'stripe'
import { ReversalRejectedError, ReversalTransientError, type DriverReversalProvider, type StripeBalanceView, type StripeReversalView, type StripeTransferView } from '../ports/driver-reversal.js'

const eur = (entries: Array<{ amount: number; currency: string }>): number => entries.filter((entry) => entry.currency === 'eur').reduce((total, entry) => total + entry.amount, 0)

/** Reversals de Transfers (SP4) : `transfers.createReversal` ; les lectures (Transfer, solde du livreur) précèdent toujours la décision du domaine. */
export class StripeDriverReversalProvider implements DriverReversalProvider {
  public readonly livemode: boolean
  public constructor(private readonly stripe: Stripe, livemode: boolean) { this.livemode = livemode }

  public async retrieveTransfer(transferId: string): Promise<StripeTransferView> {
    const transfer = await this.read(() => this.stripe.transfers.retrieve(transferId))
    return {
      transferId: transfer.id, amountCents: transfer.amount, amountReversedCents: transfer.amount_reversed,
      destinationAccountId: typeof transfer.destination === 'string' ? transfer.destination : transfer.destination?.id ?? '',
      sourceTransactionId: typeof transfer.source_transaction === 'string' ? transfer.source_transaction : transfer.source_transaction?.id ?? null,
      livemode: transfer.livemode
    }
  }

  public async retrieveDriverBalance(accountId: string): Promise<StripeBalanceView> {
    const balance = await this.read(() => this.stripe.balance.retrieve({}, { stripeAccount: accountId }))
    return { availableCents: eur(balance.available), pendingCents: eur(balance.pending) }
  }

  public async createReversal(input: Parameters<DriverReversalProvider['createReversal']>[0]): Promise<StripeReversalView> {
    try {
      const reversal = await this.stripe.transfers.createReversal(input.transferId, { amount: input.amountCents, description: input.description, metadata: input.metadata }, { idempotencyKey: input.idempotencyKey })
      return { reversalId: reversal.id, transferId: typeof reversal.transfer === 'string' ? reversal.transfer : reversal.transfer.id, amountCents: reversal.amount }
    } catch (error) {
      throw classifyReversalError(error)
    }
  }

  public async findReversal(input: { transferId: string; reversalId: string }): Promise<StripeReversalView | null> {
    const list = await this.read(() => this.stripe.transfers.listReversals(input.transferId, { limit: 100 }))
    const found = list.data.find((reversal) => reversal.metadata?.driver_transfer_reversal_id === input.reversalId)
    return found === undefined ? null : { reversalId: found.id, transferId: input.transferId, amountCents: found.amount }
  }

  private async read<T>(call: () => Promise<T>): Promise<T> {
    try { return await call() } catch (error) { throw new ReversalTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable') }
  }
}

/** Dépassement/déjà reversé/requête invalide = refus définitif ; le reste est inconnu (même clé rejouée). */
export function classifyReversalError(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeInvalidRequestError) return new ReversalRejectedError(error.code ?? 'invalid_request')
  if (error instanceof Stripe.errors.StripeIdempotencyError) return new ReversalRejectedError('idempotency_mismatch')
  return new ReversalTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable')
}
