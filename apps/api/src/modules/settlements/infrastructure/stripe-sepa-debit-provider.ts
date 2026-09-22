import Stripe from 'stripe'
import type { DebitObservation } from '../domain/sepa-debit.js'
import { SepaDebitRejectedError, SepaDebitTechnicalError, SepaDebitTransientError, SepaDebitUnavailableError, type CreateDebitInput, type SepaDebitProvider } from '../ports/sepa-debit.js'

const EXPAND = ['latest_charge.balance_transaction']

/**
 * Débit SEPA du restaurant : PaymentIntent sur la PLATEFORME (`customer_account` = Account v2 du restaurant, mandat actif, off-session).
 * Aucune application_fee / transfer_data : l'argent reste sur la plateforme, les livreurs sont payés plus tard par Transfer (R60).
 */
export class StripeSepaDebitProvider implements SepaDebitProvider {
  public readonly livemode: boolean
  public constructor(private readonly stripe: Stripe, livemode: boolean) { this.livemode = livemode }

  public async createDebit(input: CreateDebitInput): Promise<DebitObservation> {
    try {
      const params = {
        amount: input.amountCents,
        currency: 'eur',
        customer_account: input.restaurantAccountId,
        payment_method: input.paymentMethodId,
        payment_method_types: ['sepa_debit'],
        confirm: true,
        off_session: true,
        ...(input.mandateId === null ? {} : { mandate: input.mandateId }),
        transfer_group: input.transferGroup,
        description: input.description,
        metadata: input.metadata,
        expand: EXPAND
      }
      // `customer_account` (Accounts v2) n'est pas encore dans les types du SDK pour les PaymentIntents.
      const intent = await this.stripe.paymentIntents.create(params as unknown as Stripe.PaymentIntentCreateParams, { idempotencyKey: input.idempotencyKey })
      return toObservation(intent)
    } catch (error) {
      throw classifyStripeError(error)
    }
  }

  public async retrieveDebit(paymentIntentId: string): Promise<DebitObservation> {
    try {
      return toObservation(await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: EXPAND }))
    } catch (error) {
      throw classifyReadError(error)
    }
  }

  public async findDebitByAttemptId(attemptId: string): Promise<DebitObservation | null> {
    try {
      const result = await this.stripe.paymentIntents.search({ query: `metadata['debit_attempt_id']:'${attemptId.replace(/[^0-9a-f-]/gi, '')}'`, expand: ['data.latest_charge.balance_transaction'], limit: 2 })
      return result.data[0] === undefined ? null : toObservation(result.data[0])
    } catch (error) {
      throw classifyReadError(error)
    }
  }
}

export function toObservation(intent: Stripe.PaymentIntent): DebitObservation {
  const charge = typeof intent.latest_charge === 'object' && intent.latest_charge !== null ? intent.latest_charge : null
  const chargeId = charge?.id ?? (typeof intent.latest_charge === 'string' ? intent.latest_charge : null)
  const balanceTransaction = charge?.balance_transaction ?? null
  return {
    paymentIntentId: intent.id,
    paymentIntentStatus: intent.status,
    amountCents: intent.amount,
    currency: intent.currency,
    livemode: intent.livemode,
    attemptIdMetadata: intent.metadata?.debit_attempt_id ?? null,
    chargeId,
    chargeStatus: charge?.status ?? null,
    paid: charge?.paid ?? false,
    hasBalanceTransaction: balanceTransaction !== null,
    availableOn: typeof balanceTransaction === 'object' && balanceTransaction !== null ? new Date(balanceTransaction.available_on * 1000) : null,
    // Le code de la charge (ex. `incorrect_account_holder_name`) est plus précis que celui du PaymentIntent (`payment_intent_payment_attempt_failed`).
    disputed: charge?.disputed ?? false,
    amountRefundedCents: charge?.amount_refunded ?? 0,
    failureCode: charge?.failure_code ?? intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null
  }
}

/**
 * Rejet du DÉBITEUR : seule l'erreur carte/banque de Stripe (`StripeCardError`). Mauvaise requête, paramètre invalide ou clé d'idempotence
 * détournée = erreur TECHNIQUE de notre côté. Réseau, 5xx, limite, authentification/permission plateforme = transitoire (rejeu de la même clé).
 * On ne qualifie jamais un restaurant d'impayé pour un problème de requête, de configuration ou de plateforme.
 */
export function classifyStripeError(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeCardError) return new SepaDebitRejectedError(error.code ?? error.type)
  if (error instanceof Stripe.errors.StripeInvalidRequestError) return new SepaDebitTechnicalError(`invalid_request:${error.code ?? 'unknown'}`)
  if (error instanceof Stripe.errors.StripeIdempotencyError) return new SepaDebitTechnicalError('idempotency_mismatch')
  if (error instanceof Stripe.errors.StripeError) return new SepaDebitTransientError(error.type)
  return new SepaDebitUnavailableError()
}

/** Une LECTURE en échec ne prouve jamais que le prélèvement a échoué : toujours transitoire (jamais de `failed` sur une erreur de lecture). */
export function classifyReadError(error: unknown): Error {
  return error instanceof Stripe.errors.StripeError ? new SepaDebitTransientError(error.type) : new SepaDebitUnavailableError()
}
