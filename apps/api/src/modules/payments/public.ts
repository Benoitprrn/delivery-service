import type { Pool } from 'pg'
import { PostgresPaymentRepository } from './infrastructure/postgres-payment-repository.js'
import { StripeApiProvider, UnavailableStripeProvider } from './infrastructure/stripe-provider.js'
import { StripeUnavailableError, type StripeProvider } from './ports/stripe-provider.js'
import { CreateSepaSetupIntentUseCase, CompleteSepaSetupIntentUseCase, GetSepaPaymentMethodUseCase, HandleStripeWebhookUseCase, StripeWebhookSignatureError } from './application/sepa-payment-method.js'
import { ReconcileDetachmentsUseCase } from './application/reconcile-detachments.js'
import { registerPaymentHttpRoutes } from './transport/http/routes.js'
import type { Merchant, MerchantLegalInformation } from '../merchants/public.js'
import { noopPaymentsLogger, type PaymentsLogger } from './ports/payments-logger.js'

export function createStripeProvider(enabled: boolean, secretKey: string | undefined, webhookSecret: string | undefined, accountsV2ApiVersion?: string): StripeProvider {
  return enabled && secretKey !== undefined && webhookSecret !== undefined ? new StripeApiProvider(secretKey, webhookSecret, undefined, accountsV2ApiVersion) : new UnavailableStripeProvider()
}

export type PaymentsModule = {
  getMerchantStripeAccountId: (merchantId: string) => Promise<string | null>
  /** Vrai UNIQUEMENT si un moyen SEPA est `active` (mandat actif) ; tout autre état (pending, detach_pending, invalid, absent) = faux. */
  hasActiveSepaMethod: (merchantId: string) => Promise<boolean>
  /** Mandat actif : uniquement ce qui figure dans la pré-notification (4 derniers caractères de l'IBAN et référence du mandat). */
  findActiveSepaMandate: (merchantId: string) => Promise<{ last4: string | null; mandateReference: string | null } | null>
  /** Source du prélèvement (R50) : compte Stripe du restaurant + moyen SEPA ACTIF (id du PaymentMethod, mandat) ; `null` si l'un manque. */
  findActiveSepaDebitSource: (merchantId: string) => Promise<{ stripeAccountId: string; paymentMethodId: string; mandateId: string | null; mandateReference: string } | null>
  ensureMerchantStripeAccount: (merchantId: string, email: string | undefined) => Promise<{ merchantId: string; stripeAccountId: string }>
  getPaymentMethod: (merchantId: string) => Promise<ReturnType<GetSepaPaymentMethodUseCase['execute']> extends Promise<infer T> ? T : never>
  createSetupIntent: (merchantId: string, email: string | undefined) => Promise<{ clientSecret: string; setupIntentId: string }>
  completeSetupIntent: (merchantId: string, setupIntentId: string) => Promise<ReturnType<CompleteSepaSetupIntentUseCase['execute']> extends Promise<infer T> ? T : never>
  receiveWebhook: (payload: string | Buffer, signature: string) => Promise<void>
  processWebhookBatch: () => Promise<number>
  reconcileDetachments: () => Promise<number>
  runBackgroundCycle: () => Promise<void>
}

/** Événement plateforme vérifié (signature contrôlée) transmis à d'autres capacités (ex. règlement livreurs) : un déclencheur, jamais une source de vérité. */
export type VerifiedPlatformEvent = { id: string; type: string; account?: string | null; data: { object: Record<string, unknown> } }

export function createPaymentsModule(pool: Pool, stripe: StripeProvider, findMerchant: (id: string) => Promise<Merchant | null>, findLegalInformation: (id: string) => Promise<MerchantLegalInformation | null>, logger: PaymentsLogger = noopPaymentsLogger, eventSink?: (event: VerifiedPlatformEvent) => Promise<unknown>): PaymentsModule {
  const repository = new PostgresPaymentRepository(pool)
  const complete = new CompleteSepaSetupIntentUseCase(repository, stripe)
  const create = new CreateSepaSetupIntentUseCase(repository, stripe, findMerchant, findLegalInformation, complete, undefined, logger)
  const get = new GetSepaPaymentMethodUseCase(repository)
  const webhook = new HandleStripeWebhookUseCase(repository, complete, logger)
  const reconcile = new ReconcileDetachmentsUseCase(repository, stripe, logger)
  return {
    getMerchantStripeAccountId: async (merchantId: string) => (await repository.findProfile(merchantId))?.stripeAccountId ?? null,
    hasActiveSepaMethod: async (merchantId: string) => (await repository.findActive(merchantId)) !== null,
    findActiveSepaDebitSource: async (merchantId: string) => {
      const [profile, active] = await Promise.all([repository.findProfile(merchantId), repository.findActive(merchantId)])
      return profile === null || active === null || active.stripePaymentMethodId === null || active.mandateReference === null
        ? null
        : { stripeAccountId: profile.stripeAccountId, paymentMethodId: active.stripePaymentMethodId, mandateId: active.stripeMandateId, mandateReference: active.mandateReference }
    },
    findActiveSepaMandate: async (merchantId: string) => { const active = await repository.findActive(merchantId); return active === null ? null : { last4: active.last4, mandateReference: active.mandateReference } },
    ensureMerchantStripeAccount: create.ensureMerchantStripeAccount.bind(create),
    getPaymentMethod: get.execute.bind(get),
    createSetupIntent: create.execute.bind(create),
    completeSetupIntent: complete.execute.bind(complete),
    receiveWebhook: async (payload: string | Buffer, signature: string) => {
      let event
      try {
        event = stripe.constructEvent(payload, signature)
      } catch (error) {
        if (error instanceof StripeUnavailableError) throw error
        throw new StripeWebhookSignatureError('Invalid Stripe webhook signature')
      }
      await webhook.receive(event)
      // Même événement vérifié, transmis (sans payload conservé) au journal du règlement : une erreur remonte, Stripe rejouera l'événement.
      if (eventSink !== undefined) await eventSink({ id: event.id, type: event.type, account: event.account ?? null, data: { object: event.data.object as unknown as Record<string, unknown> } })
    },
    processWebhookBatch: webhook.processBatch.bind(webhook),
    reconcileDetachments: reconcile.run.bind(reconcile),
    runBackgroundCycle: async () => {
      await webhook.processBatch()
      await reconcile.run()
    }
  }
}

export type StripePaymentsWorkerCycle = {
  processWebhooks: () => Promise<unknown>
  reconcileDetachments: () => Promise<unknown>
}

export function startStripePaymentsWorker(cycle: StripePaymentsWorkerCycle, logger: PaymentsLogger = noopPaymentsLogger, intervalMs = 2_000): () => void {
  let processing = false
  const run = async (): Promise<void> => {
    if (processing) return
    processing = true
    try {
      try {
        await cycle.processWebhooks()
      } catch (error) {
        const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
        logger.error({ errorClass }, 'Stripe webhook worker cycle failed')
      }
      try {
        await cycle.reconcileDetachments()
      } catch (error) {
        const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
        logger.error({ errorClass }, 'Stripe detachment reconciliation cycle failed')
      }
    } finally { processing = false }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}

export { registerPaymentHttpRoutes }
export { StripeIdempotencyConflictError, StripeProviderError, StripeUnavailableError } from './ports/stripe-provider.js'
export { LegalInformationRequiredError, PaymentConfigurationError } from './application/sepa-payment-method.js'
export type { StripeProvider } from './ports/stripe-provider.js'
export type { PaymentsLogger } from './ports/payments-logger.js'
export {
  createStripeConnectWebhookModule,
  reconcilerNotWired,
  registerStripeConnectWebhookRoute,
  startStripeConnectWebhookWorker
} from './connect-webhooks.js'
export type { ConnectWebhookDomainPorts, StripeConnectWebhookModule } from './connect-webhooks.js'
