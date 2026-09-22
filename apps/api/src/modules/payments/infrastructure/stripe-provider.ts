import Stripe from 'stripe'
import { StripeAccountTokenRequiredError, StripeIdempotencyConflictError, StripeProviderError, StripeResourceMissingError, StripeUnavailableError, type CustomerAccountDetails, type StripeProvider, type SetupResult } from '../ports/stripe-provider.js'

export class StripeApiProvider implements StripeProvider {
  private readonly stripe: Stripe
  constructor(secretKey: string, private readonly webhookSecret: string, client: Stripe = new Stripe(secretKey, { timeout: 20_000, maxNetworkRetries: 2 }), private readonly accountsV2ApiVersion?: string) {
    this.stripe = client
  }
  async createCustomerAccount(input: { merchantId: string }): Promise<{ id: string }> {
    const account = await this.request(
      () => this.stripe.v2.core.accounts.create({ configuration: { customer: {} }, metadata: { merchant_id: input.merchantId } }, { ...this.accountsV2VersionOption(), idempotencyKey: `merchant-customer-account-${input.merchantId}` }),
      { idempotencyConflict: true }
    )
    return { id: account.id }
  }
  async hasMerchantConfiguration(accountId: string): Promise<boolean> {
    const version = this.accountsV2ApiVersion
    const account = await this.request(() => version === undefined
      ? this.stripe.v2.core.accounts.retrieve(accountId)
      : this.stripe.v2.core.accounts.retrieve(accountId, {}, { apiVersion: version }))
    return account.applied_configurations.includes('merchant')
  }
  async updateCustomerAccount(accountId: string, details: CustomerAccountDetails): Promise<void> {
    const country = details.address.countryCode.toLowerCase()
    const line2 = details.address.line2.trim()
    const address = {
      line1: details.address.line1,
      ...(line2 === '' ? {} : { line2 }),
      city: details.address.city,
      postal_code: details.address.postalCode,
      country
    }
    const params = {
      contact_email: details.email,
      display_name: details.legalName,
      identity: {
        country,
        entity_type: 'company' as const,
        business_details: {
          registered_name: details.legalName,
          address
        }
      }
    }
    // Un objet d'options vide n'est pas reconnu comme options par le SDK : sans version explicite, pas de 3e argument.
    const version = this.accountsV2ApiVersion
    await this.request(() => version === undefined
      ? this.stripe.v2.core.accounts.update(accountId, params)
      : this.stripe.v2.core.accounts.update(accountId, params, { apiVersion: version }), { accountTokenRequired: true })
  }
  async createSetupIntent(input: { customerAccountId: string; merchantId: string }): Promise<SetupResult> {
    const intent = await this.request(() => this.stripe.setupIntents.create({ customer_account: input.customerAccountId, allowed_payment_method_types: ['sepa_debit'], usage: 'off_session', metadata: { merchant_id: input.merchantId } }))
    if (intent.client_secret === null) throw new Error('Stripe SetupIntent has no client secret')
    return { setupIntentId: intent.id, clientSecret: intent.client_secret }
  }
  retrieveSetupIntent(id: string): Promise<Stripe.SetupIntent> { return this.request(() => this.stripe.setupIntents.retrieve(id)) }
  retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod> { return this.request(() => this.stripe.paymentMethods.retrieve(id)) }
  retrieveMandate(id: string): Promise<Stripe.Mandate> { return this.request(() => this.stripe.mandates.retrieve(id)) }
  async detachPaymentMethod(id: string): Promise<void> {
    try {
      await this.stripe.paymentMethods.detach(id)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        throw new StripeResourceMissingError()
      }
      if (error instanceof Stripe.errors.StripeError) throw new StripeProviderError(error)
      throw error
    }
  }
  constructEvent(payload: string | Buffer, signature: string): Stripe.Event { return this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret) }

  // Aucune version explicite par défaut : le SDK envoie sa version GA (Accounts v2 est GA avec Connect).
  // STRIPE_ACCOUNTS_V2_API_VERSION n'est qu'un override, transmis en RequestOptions et jamais dans les paramètres.
  private accountsV2VersionOption(): { apiVersion?: string } {
    return this.accountsV2ApiVersion === undefined ? {} : { apiVersion: this.accountsV2ApiVersion }
  }

  private async request<T>(operation: () => Promise<T>, options: { idempotencyConflict?: boolean; accountTokenRequired?: boolean } = {}): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (options.idempotencyConflict && this.isIdempotencyConflict(error)) throw new StripeIdempotencyConflictError(error)
      if (options.accountTokenRequired && error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'account_token_required') throw new StripeAccountTokenRequiredError(error)
      if (error instanceof Stripe.errors.StripeError) throw new StripeProviderError(error)
      throw error
    }
  }

  private isIdempotencyConflict(error: unknown): boolean {
    return error instanceof Stripe.errors.StripeIdempotencyError || (
      error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'idempotency_key_in_use'
    )
  }
}

export class UnavailableStripeProvider implements StripeProvider {
  // Les méthodes asynchrones du port renvoient une promesse rejetée (jamais une
  // exception synchrone) ; seule constructEvent, synchrone par contrat, lève.
  private unavailableError(): StripeUnavailableError { return new StripeUnavailableError('Stripe is not configured') }
  createCustomerAccount(): Promise<{ id: string }> { return Promise.reject(this.unavailableError()) }
  hasMerchantConfiguration(): Promise<boolean> { return Promise.reject(this.unavailableError()) }
  updateCustomerAccount(): Promise<void> { return Promise.reject(this.unavailableError()) }
  createSetupIntent(): Promise<SetupResult> { return Promise.reject(this.unavailableError()) }
  retrieveSetupIntent(): Promise<Stripe.SetupIntent> { return Promise.reject(this.unavailableError()) }
  retrievePaymentMethod(): Promise<Stripe.PaymentMethod> { return Promise.reject(this.unavailableError()) }
  retrieveMandate(): Promise<Stripe.Mandate> { return Promise.reject(this.unavailableError()) }
  detachPaymentMethod(): Promise<void> { return Promise.reject(this.unavailableError()) }
  constructEvent(): Stripe.Event { throw this.unavailableError() }
}
