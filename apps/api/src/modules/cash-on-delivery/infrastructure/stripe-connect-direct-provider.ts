import Stripe from 'stripe'
import {
  ConnectProviderError,
  ConnectResourceMissingError,
  ConnectUnavailableError,
  PaymentIntentUnexpectedStateError,
  type CapabilityStatus,
  type ConnectAccountStatus,
  type ConnectPaymentsProvider,
  type TerminalAddress,
  type TerminalPaymentIntent
} from '../ports/connect-payments-provider.js'

/**
 * Implémentation DIRECT CHARGE : le PaymentIntent, la Location et le
 * ConnectionToken appartiennent au compte du restaurant (en-tête Stripe-Account).
 * Locadely ne prélève aucune commission (`application_fee_amount` jamais envoyé).
 * `apiVersion` n'est transmis que dans les options de requête des appels
 * `v2.core.*`, et uniquement s'il est configuré (voir apps/api/CLAUDE.md).
 */
export class StripeConnectDirectProvider implements ConnectPaymentsProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly accountsV2ApiVersion?: string
  ) {}

  async addMerchantConfiguration(input: { accountId: string }): Promise<void> {
    const params = {
      dashboard: 'full' as const,
      defaults: { responsibilities: { fees_collector: 'stripe' as const, losses_collector: 'stripe' as const } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true }, cartes_bancaires_payments: { requested: true } } } }
    }
    await this.request(() => this.v2Accounts(input.accountId, params))
  }

  async createOnboardingLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.request(() => this.stripe.v2.core.accountLinks.create(
      {
        account: input.accountId,
        use_case: {
          type: 'account_onboarding',
          // Doit être EXACTEMENT l'ensemble des configurations appliquées au compte (vérifié en Sandbox).
          account_onboarding: { configurations: ['customer', 'merchant'], return_url: input.returnUrl, refresh_url: input.refreshUrl }
        }
      },
      this.v2Options()
    ))
    return { url: link.url, expiresAt: new Date(link.expires_at) }
  }

  async getAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
    const params = { include: ['configuration.merchant', 'requirements'] as Array<'configuration.merchant' | 'requirements'> }
    const account = await this.request(() => this.stripe.v2.core.accounts.retrieve(accountId, params, this.v2Options()))
    const capabilities = account.configuration?.merchant?.capabilities
    return {
      accountId,
      merchantConfigured: account.applied_configurations.includes('merchant'),
      dashboard: account.dashboard ?? null,
      cardPayments: capabilityStatus(capabilities?.card_payments),
      cartesBancaires: capabilityStatus(capabilities?.cartes_bancaires_payments),
      requirementsCount: account.requirements?.entries?.length ?? 0
    }
  }

  async ensureTerminalLocation(input: { accountId: string; displayName: string; address: TerminalAddress }): Promise<{ locationId: string }> {
    const options = { stripeAccount: input.accountId }
    const existing = await this.request(() => this.stripe.terminal.locations.list({ limit: 100 }, options))
    const found = existing.data.find((location) => location.display_name === input.displayName)
    if (found !== undefined) return { locationId: found.id }
    const created = await this.request(() => this.stripe.terminal.locations.create({
      display_name: input.displayName,
      address: { line1: input.address.line1, city: input.address.city, postal_code: input.address.postalCode, country: input.address.country }
    }, options))
    return { locationId: created.id }
  }

  async createConnectionToken(input: { accountId: string; locationId: string }): Promise<{ secret: string }> {
    const token = await this.request(() => this.stripe.terminal.connectionTokens.create({ location: input.locationId }, { stripeAccount: input.accountId }))
    return { secret: token.secret }
  }

  async createTerminalPaymentIntent(input: {
    accountId: string
    amountCents: number
    currency: 'eur'
    idempotencyKey: string
    metadata: { orderId: string; merchantId: string; paymentId: string }
  }): Promise<TerminalPaymentIntent> {
    const intent = await this.request(() => this.stripe.paymentIntents.create({
      amount: input.amountCents,
      currency: input.currency,
      // Terminal : card_present obligatoire (seule exception à la règle « pas de payment_method_types »).
      payment_method_types: ['card_present'],
      capture_method: 'manual',
      metadata: { order_id: input.metadata.orderId, merchant_id: input.metadata.merchantId, payment_id: input.metadata.paymentId }
    }, { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey }))
    return mapIntent(input.accountId, intent)
  }

  async retrievePaymentIntent(input: { accountId: string; paymentIntentId: string }): Promise<TerminalPaymentIntent> {
    const intent = await this.request(() => this.stripe.paymentIntents.retrieve(input.paymentIntentId, {}, { stripeAccount: input.accountId }))
    return mapIntent(input.accountId, intent)
  }

  async capturePaymentIntent(input: { accountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<TerminalPaymentIntent> {
    // Jamais de `amount_to_capture` : le montant capturé est celui du PI.
    const intent = await this.request(() => this.stripe.paymentIntents.capture(input.paymentIntentId, {}, { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey }))
    return mapIntent(input.accountId, intent)
  }

  async cancelPaymentIntent(input: { accountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<TerminalPaymentIntent> {
    const intent = await this.request(() => this.stripe.paymentIntents.cancel(input.paymentIntentId, {}, { stripeAccount: input.accountId, idempotencyKey: input.idempotencyKey }))
    return mapIntent(input.accountId, intent)
  }

  private v2Options(): { apiVersion?: string } {
    return this.accountsV2ApiVersion === undefined ? {} : { apiVersion: this.accountsV2ApiVersion }
  }

  // Un objet d'options vide n'est pas reconnu comme options par le SDK : pas de 3e argument sans version explicite.
  private v2Accounts(accountId: string, params: Parameters<Stripe['v2']['core']['accounts']['update']>[1]) {
    return this.accountsV2ApiVersion === undefined
      ? this.stripe.v2.core.accounts.update(accountId, params)
      : this.stripe.v2.core.accounts.update(accountId, params, { apiVersion: this.accountsV2ApiVersion })
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        if (error.code === 'payment_intent_unexpected_state') throw new PaymentIntentUnexpectedStateError(error)
        if (error.code === 'resource_missing') throw new ConnectResourceMissingError(error)
      }
      if (error instanceof Stripe.errors.StripeError) throw new ConnectProviderError(error)
      throw error
    }
  }
}

export class UnavailableConnectPaymentsProvider implements ConnectPaymentsProvider {
  private unavailable(): ConnectUnavailableError { return new ConnectUnavailableError('Stripe is not configured') }
  addMerchantConfiguration(): Promise<void> { return Promise.reject(this.unavailable()) }
  createOnboardingLink(): Promise<{ url: string; expiresAt: Date }> { return Promise.reject(this.unavailable()) }
  getAccountStatus(): Promise<ConnectAccountStatus> { return Promise.reject(this.unavailable()) }
  ensureTerminalLocation(): Promise<{ locationId: string }> { return Promise.reject(this.unavailable()) }
  createConnectionToken(): Promise<{ secret: string }> { return Promise.reject(this.unavailable()) }
  createTerminalPaymentIntent(): Promise<TerminalPaymentIntent> { return Promise.reject(this.unavailable()) }
  retrievePaymentIntent(): Promise<TerminalPaymentIntent> { return Promise.reject(this.unavailable()) }
  capturePaymentIntent(): Promise<TerminalPaymentIntent> { return Promise.reject(this.unavailable()) }
  cancelPaymentIntent(): Promise<TerminalPaymentIntent> { return Promise.reject(this.unavailable()) }
}

function capabilityStatus(capability: { status?: string } | null | undefined): CapabilityStatus {
  if (capability === null || capability === undefined || capability.status === undefined) return 'not_requested'
  return capability.status === 'active' || capability.status === 'pending' || capability.status === 'restricted' || capability.status === 'inactive'
    ? capability.status
    : 'inactive'
}

function mapIntent(accountId: string, intent: Stripe.PaymentIntent): TerminalPaymentIntent {
  return {
    id: intent.id,
    accountId,
    status: intent.status,
    amountCents: intent.amount,
    amountCapturableCents: intent.amount_capturable,
    amountReceivedCents: intent.amount_received,
    currency: intent.currency,
    clientSecret: intent.client_secret ?? null,
    metadata: { ...intent.metadata },
    captureMethod: intent.capture_method,
    paymentMethodTypes: [...intent.payment_method_types],
    applicationFeeAmountCents: intent.application_fee_amount ?? null,
    hasTransferData: intent.transfer_data !== null && intent.transfer_data !== undefined,
    hasOnBehalfOf: intent.on_behalf_of !== null && intent.on_behalf_of !== undefined,
    chargeId: typeof intent.latest_charge === 'string' ? intent.latest_charge : (intent.latest_charge?.id ?? null),
    lastPaymentErrorCode: intent.last_payment_error?.code ?? null,
    lastPaymentErrorDeclineCode: intent.last_payment_error?.decline_code ?? null
  }
}
