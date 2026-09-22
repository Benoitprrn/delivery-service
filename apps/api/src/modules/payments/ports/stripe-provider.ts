import type Stripe from 'stripe'

export class StripeUnavailableError extends Error {}
export class StripeResourceMissingError extends Error {}
export class StripeIdempotencyConflictError extends Error {
  constructor(cause?: unknown) {
    super('Stripe account creation is already in progress', { cause })
  }
}
export class StripeProviderError extends Error {
  constructor(cause?: unknown) {
    super('Stripe provider request failed', { cause })
  }
}
export class StripeAccountTokenRequiredError extends Error {
  constructor(cause?: unknown) {
    super('Stripe Account update requires an account token', { cause })
  }
}

export type SetupResult = {
  setupIntentId: string
  clientSecret: string
}

export type CustomerAccountDetails = {
  email: string
  legalName: string
  address: { line1: string; line2: string; city: string; postalCode: string; countryCode: string }
}

export interface StripeProvider {
  createCustomerAccount(input: { merchantId: string }): Promise<{ id: string }>
  hasMerchantConfiguration(accountId: string): Promise<boolean>
  updateCustomerAccount(accountId: string, details: CustomerAccountDetails): Promise<void>
  createSetupIntent(input: { customerAccountId: string; merchantId: string }): Promise<SetupResult>
  retrieveSetupIntent(id: string): Promise<Stripe.SetupIntent>
  retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod>
  retrieveMandate(id: string): Promise<Stripe.Mandate>
  detachPaymentMethod(id: string): Promise<void>
  constructEvent(payload: string | Buffer, signature: string): Stripe.Event
}
