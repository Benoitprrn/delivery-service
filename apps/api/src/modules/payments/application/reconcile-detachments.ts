import type { PaymentRepository } from '../ports/payment-repository.js'
import { StripeResourceMissingError, type StripeProvider } from '../ports/stripe-provider.js'
import { noopPaymentsLogger, type PaymentsLogger } from '../ports/payments-logger.js'

export class ReconcileDetachmentsUseCase {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly stripe: StripeProvider,
    private readonly logger: PaymentsLogger = noopPaymentsLogger
  ) {}

  async run(limit = 10): Promise<number> {
    const claims = await this.repository.claimDetachPending(limit)

    for (const claim of claims) {
      try {
        await this.stripe.detachPaymentMethod(claim.paymentMethodId)
        await this.repository.markDetached(claim.paymentMethodId)
      } catch (error) {
        if (error instanceof StripeResourceMissingError) {
          await this.repository.markDetached(claim.paymentMethodId)
          continue
        }

        const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
        await this.repository.recordDetachFailure({
          paymentMethodId: claim.paymentMethodId,
          token: claim.token,
          errorClass
        })
        this.logger.error({ paymentMethodId: claim.paymentMethodId, errorClass }, 'Stripe payment method detachment failed')
      }
    }

    return claims.length
  }
}
