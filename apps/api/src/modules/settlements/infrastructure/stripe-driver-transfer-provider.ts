import Stripe from 'stripe'
import { TransferRejectedError, TransferTransientError, type CreateTransferInput, type DriverTransferProvider, type TransferResult } from '../ports/driver-payout.js'

/**
 * Transfers « Separate Charges and Transfers » : `source_transaction` = la charge SEPA du restaurant (jamais `platform_advance`, D-M).
 * Le `transfer_group` est hérité de la charge (`settlement:<règlement>`) ; le Transfer se retrouve par `metadata.driver_transfer_id`.
 */
export class StripeDriverTransferProvider implements DriverTransferProvider {
  public readonly livemode: boolean
  public constructor(private readonly stripe: Stripe, livemode: boolean) { this.livemode = livemode }

  public async createTransfer(input: CreateTransferInput): Promise<TransferResult> {
    try {
      const transfer = await this.stripe.transfers.create({
        amount: input.amountCents,
        currency: 'eur',
        destination: input.destinationAccountId,
        source_transaction: input.sourceTransactionId,
        description: input.description,
        metadata: input.metadata
      }, { idempotencyKey: input.idempotencyKey })
      return toTransferResult(transfer)
    } catch (error) {
      throw classifyTransferError(error)
    }
  }

  public async findTransfer(input: { transferGroup: string; driverTransferId: string }): Promise<TransferResult | null> {
    try {
      for await (const transfer of this.stripe.transfers.list({ transfer_group: input.transferGroup, limit: 100 })) {
        if (transfer.metadata?.driver_transfer_id === input.driverTransferId) return toTransferResult(transfer)
      }
      return null
    } catch (error) {
      throw new TransferTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable')
    }
  }

  public async annotateDestinationPayment(input: { destinationAccountId: string; destinationPaymentId: string; description: string; metadata: Record<string, string> }): Promise<void> {
    try {
      await this.stripe.charges.update(input.destinationPaymentId, { description: input.description, metadata: input.metadata }, { stripeAccount: input.destinationAccountId })
    } catch (error) {
      throw new TransferTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable')
    }
  }
}

export function toTransferResult(transfer: Stripe.Transfer): TransferResult {
  return {
    transferId: transfer.id,
    amountCents: transfer.amount,
    currency: transfer.currency,
    destinationAccountId: typeof transfer.destination === 'string' ? transfer.destination : transfer.destination?.id ?? '',
    sourceTransactionId: typeof transfer.source_transaction === 'string' ? transfer.source_transaction : transfer.source_transaction?.id ?? null,
    destinationPaymentId: typeof transfer.destination_payment === 'string' ? transfer.destination_payment : transfer.destination_payment?.id ?? null,
    livemode: transfer.livemode
  }
}

/** Requête invalide, capacité manquante ou clé détournée = refus définitif de CE Transfer ; authentification/permission plateforme, réseau, 5xx = inconnu, rejeu de la même clé. */
export function classifyTransferError(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    const code = error.code ?? error.type
    return new TransferRejectedError(code, /capabilit/i.test(code) || /capabilit/i.test(error.message))
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) return new TransferRejectedError('idempotency_mismatch', false)
  return new TransferTransientError(error instanceof Stripe.errors.StripeError ? error.type : 'unavailable')
}
