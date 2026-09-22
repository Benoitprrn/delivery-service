import { isMerchantLegalInformationComplete, type Merchant, type MerchantLegalInformation } from '../../merchants/public.js'
import type Stripe from 'stripe'
import type { MerchantPaymentMethod, PaymentRepository, StoredStripeWebhookEvent } from '../ports/payment-repository.js'
import { StripeAccountTokenRequiredError, StripeIdempotencyConflictError, type CustomerAccountDetails, type StripeProvider } from '../ports/stripe-provider.js'
import { noopPaymentsLogger, type PaymentsLogger } from '../ports/payments-logger.js'

export class PaymentMethodNotReadyError extends Error {}
export class StripeSetupFailedError extends Error {}
export class PaymentConfigurationError extends Error {}
export class LegalInformationRequiredError extends Error {}
export class SetupProcessingError extends Error {
  constructor() { super('SetupIntent is still processing') }
}
export class SetupAlreadyCompletedError extends Error {
  constructor() { super('SetupIntent has already been completed') }
}
export class SetupStatusUnsupportedError extends Error {
  constructor() { super('SetupIntent has an unsupported status') }
}
export class WebhookEventInProgressError extends Error {}
export class StripeWebhookSignatureError extends Error {}
export class UnknownSetupIntentError extends Error {}

function customerAccountDetails(legal: MerchantLegalInformation, email: string): CustomerAccountDetails {
  const address = legal.billingAddress ?? legal.legalAddress
  return {
    email,
    legalName: legal.legalName,
    address: {
      line1: address.line1,
      line2: address.line2 ?? '',
      city: address.city,
      postalCode: address.postalCode,
      countryCode: address.countryCode
    }
  }
}

export class GetSepaPaymentMethodUseCase { constructor(private readonly repository: PaymentRepository) {} execute(merchantId:string):Promise<MerchantPaymentMethod|null>{return this.repository.findDisplayMethod(merchantId)} }

export class CreateSepaSetupIntentUseCase {
  private readonly profileCreation = new Map<string, Promise<{ merchantId: string; stripeAccountId: string }>>()
  constructor(
    private readonly repository: PaymentRepository,
    private readonly stripe: StripeProvider,
    private readonly findMerchant: (id: string) => Promise<Merchant | null>,
    private readonly findLegalInformation: (id: string) => Promise<MerchantLegalInformation | null>,
    private readonly complete: CompleteSepaSetupIntentUseCase,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly logger: PaymentsLogger = noopPaymentsLogger
  ) {}
  async execute(merchantId:string,email:string|undefined):Promise<{clientSecret:string;setupIntentId:string}>{
    const profile = await this.ensureMerchantStripeAccount(merchantId, email)
    const pending = await this.repository.findPending(merchantId)
    if (pending !== null) {
      const intent = await this.stripe.retrieveSetupIntent(pending.setupIntentId)
      if (
        intent.status === 'requires_payment_method' ||
        intent.status === 'requires_confirmation' ||
        intent.status === 'requires_action'
      ) {
        if (intent.client_secret === null) throw new SetupStatusUnsupportedError()
        return { setupIntentId: pending.setupIntentId, clientSecret: intent.client_secret }
      }
      if (intent.status === 'processing') throw new SetupProcessingError()
      if (intent.status === 'succeeded') {
        await this.complete.execute(merchantId, pending.setupIntentId)
        throw new SetupAlreadyCompletedError()
      }
      if (intent.status === 'canceled') await this.repository.invalidatePending(pending.setupIntentId)
      else if (intent.status !== 'canceled') {
        this.logger.warn({ merchantId, setupIntentId: pending.setupIntentId, status: intent.status }, 'Unsupported Stripe SetupIntent status')
        throw new SetupStatusUnsupportedError()
      }
    }
    const setup=await this.stripe.createSetupIntent({customerAccountId:profile.stripeAccountId,merchantId})
    await this.repository.createPending(merchantId,setup.setupIntentId)
    return setup
  }

  async ensureMerchantStripeAccount(merchantId: string, email: string | undefined): Promise<{ merchantId: string; stripeAccountId: string }> {
    const merchant=await this.findMerchant(merchantId); if(merchant===null)throw new Error('Merchant not found')
    if(email===undefined||email.trim()==='')throw new PaymentConfigurationError('Merchant account email is unavailable')
    const legal=await this.findLegalInformation(merchantId); if(legal===null||!isMerchantLegalInformationComplete(legal))throw new LegalInformationRequiredError('Complete legal information before adding a payment method')
    const details=customerAccountDetails(legal,email)
    let profile = await this.repository.findProfile(merchantId)
    if (profile === null) {
      let creating = this.profileCreation.get(merchantId)
      if (creating === undefined) {
        creating = this.createProfile(merchantId)
        this.profileCreation.set(merchantId, creating)
        void creating.finally(() => this.profileCreation.delete(merchantId)).catch(() => undefined)
      }
      profile = await creating
    }
    const hasMerchantConfiguration = await this.stripe.hasMerchantConfiguration(profile.stripeAccountId)
    if (!hasMerchantConfiguration) {
      try {
        await this.stripe.updateCustomerAccount(profile.stripeAccountId, details)
      } catch (error) {
        if (!(error instanceof StripeAccountTokenRequiredError)) throw error
      }
    }
    return profile
  }

  private async createProfile(merchantId: string): Promise<{ merchantId: string; stripeAccountId: string }> {
    let conflict: StripeIdempotencyConflictError | undefined
    for (const delay of [0, 100, 250, 500]) {
      if (delay > 0) {
        await this.sleep(delay)
        const existing = await this.repository.findProfile(merchantId)
        if (existing !== null) return existing
      }
      try {
        const account = await this.stripe.createCustomerAccount({ merchantId })
        const profile = await this.repository.saveProfile({ merchantId, stripeAccountId: account.id })
        if (profile.stripeAccountId !== account.id) {
          this.logger.warn({ merchantId, createdAccountId: account.id, keptAccountId: profile.stripeAccountId }, 'Orphan Stripe customer Account created')
        }
        return profile
      } catch (error) {
        if (!(error instanceof StripeIdempotencyConflictError)) throw error
        conflict = error
      }
    }
    throw conflict
  }
}

export class CompleteSepaSetupIntentUseCase {
  constructor(private readonly repository:PaymentRepository,private readonly stripe:StripeProvider){}
  async execute(merchantId:string,setupIntentId:string):Promise<MerchantPaymentMethod>{
    const pending=await this.repository.findBySetupIntent(setupIntentId)
    if (pending === null || pending.merchantId !== merchantId) throw new PaymentMethodNotReadyError('Unknown SetupIntent')
    if (pending.status === 'active') return pending
    if (pending.status === 'invalid' || pending.status === 'detach_pending' || pending.status === 'detached') throw new PaymentMethodNotReadyError('SetupIntent is not ready')
    const profile=await this.repository.findProfile(merchantId)
    if (profile === null) throw new PaymentMethodNotReadyError('Unknown SetupIntent')
    const intent=await this.stripe.retrieveSetupIntent(setupIntentId)
    if (intent.status === 'processing') throw new SetupProcessingError()
    if (intent.status !== 'succeeded') throw new StripeSetupFailedError('SetupIntent is not completed')
    if(intent.customer_account!==profile.stripeAccountId||intent.metadata?.merchant_id!==merchantId)throw new StripeSetupFailedError('SetupIntent is not completed for this merchant')
    const pm=typeof intent.payment_method==='string'?await this.stripe.retrievePaymentMethod(intent.payment_method):intent.payment_method
    if(pm===null||pm===undefined||pm.type!=='sepa_debit'||pm.customer_account!==profile.stripeAccountId||pm.sepa_debit===null||pm.sepa_debit===undefined)throw new StripeSetupFailedError('SetupIntent has no SEPA payment method')
    const mandate=typeof intent.mandate==='string'?await this.stripe.retrieveMandate(intent.mandate):intent.mandate
    if(mandate===null||mandate===undefined||(typeof mandate.payment_method==='string'?mandate.payment_method:mandate.payment_method?.id)!==pm.id)throw new StripeSetupFailedError('SetupIntent has no matching SEPA mandate')
    const sepa=pm.sepa_debit
    const result=await this.repository.activate(setupIntentId,{stripePaymentMethodId:pm.id,stripeMandateId:mandate.id,bankName:null,last4:sepa.last4??null,country:sepa.country??null,mandateReference:mandate.payment_method_details?.sepa_debit?.reference??null})
    return result.active
  }
}

export class HandleStripeWebhookUseCase {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly complete: CompleteSepaSetupIntentUseCase,
    private readonly logger: PaymentsLogger = noopPaymentsLogger
  ) {}
  async receive(event: Stripe.Event): Promise<void> {
    const handledTypes = new Set([
      'setup_intent.succeeded',
      'setup_intent.setup_failed',
      'setup_intent.canceled',
      'mandate.updated',
      'payment_method.detached'
    ])
    if (!handledTypes.has(event.type)) {
      this.logger.debug({ eventId: event.id, eventType: event.type }, 'Ignoring unsupported Stripe webhook event')
      return
    }
    const object = event.data.object as { id?: string; metadata?: { merchant_id?: string }; status?: string }
    if (typeof object.id !== 'string') {
      this.logger.warn({ eventId: event.id, eventType: event.type, reason: 'missing_object_id' }, 'Ignoring Stripe webhook event without an object id')
      return
    }
    const merchantId = typeof object.metadata?.merchant_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(object.metadata.merchant_id)
      ? object.metadata.merchant_id
      : null
    await this.repository.recordWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      objectId: object.id,
      merchantId,
      objectStatus: typeof object.status === 'string' ? object.status : null
    })
  }
  async processBatch(limit = 10): Promise<number> {
    let processed = 0
    while (processed < limit) {
      const claim = await this.repository.claimNextWebhookEvent()
      if (claim === null) break
      processed += 1
      try {
        await this.process(claim.event)
        const completed = await this.repository.completeWebhookEvent(claim.event.eventId, claim.token)
        if (!completed) this.logger.warn({ eventId: claim.event.eventId, eventType: claim.event.eventType }, 'Stripe webhook claim lost before completion')
      } catch (error) {
        const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError'
        await this.repository.failWebhookEvent({ eventId: claim.event.eventId, token: claim.token, errorClass })
        this.logger.error({ eventId: claim.event.eventId, eventType: claim.event.eventType, errorClass }, 'Stripe webhook event processing failed')
      }
    }
    return processed
  }
  private async process(event: StoredStripeWebhookEvent): Promise<void> {
    if (event.eventType === 'setup_intent.succeeded') {
      const method = await this.repository.findBySetupIntent(event.objectId)
      if (method === null) throw new UnknownSetupIntentError()
      if (method.status === 'setup_pending') await this.complete.execute(method.merchantId, event.objectId)
      else if (method.status === 'invalid' || method.status === 'detach_pending' || method.status === 'detached') this.logger.info({ eventId: event.eventId, eventType: event.eventType }, 'Ignoring terminal Stripe SetupIntent event')
    } else if (event.eventType === 'setup_intent.setup_failed' || event.eventType === 'setup_intent.canceled') {
      await this.repository.invalidatePending(event.objectId)
    } else if (event.eventType === 'payment_method.detached') {
      await this.repository.markDetached(event.objectId)
    } else if (event.eventType === 'mandate.updated' && event.objectStatus === 'inactive') {
      await this.repository.markMandateInactive(event.objectId)
    }
  }
}
