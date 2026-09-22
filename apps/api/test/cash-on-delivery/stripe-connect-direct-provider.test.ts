import Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectProviderError,
  ConnectResourceMissingError,
  ConnectUnavailableError,
  PaymentIntentUnexpectedStateError
} from '../../src/modules/cash-on-delivery/ports/connect-payments-provider.js'
import { StripeConnectDirectProvider, UnavailableConnectPaymentsProvider } from '../../src/modules/cash-on-delivery/infrastructure/stripe-connect-direct-provider.js'

const ACCOUNT = 'acct_restaurant_a'

function intent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pi_1', status: 'requires_capture', amount: 5000, amount_capturable: 5000, amount_received: 0, currency: 'eur',
    client_secret: 'pi_1_secret', metadata: { order_id: 'o1' }, capture_method: 'manual', payment_method_types: ['card_present'],
    application_fee_amount: null, transfer_data: null, on_behalf_of: null, latest_charge: null, last_payment_error: null, ...over
  }
}
function stub() {
  return {
    v2: { core: { accounts: { update: vi.fn(), retrieve: vi.fn() }, accountLinks: { create: vi.fn() } } },
    terminal: { locations: { list: vi.fn(), create: vi.fn() }, connectionTokens: { create: vi.fn() } },
    paymentIntents: { create: vi.fn(), retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() }
  }
}
type Stub = ReturnType<typeof stub>
const provider = (client: Stub, version?: string) => new StripeConnectDirectProvider(client as unknown as Stripe, version)
const invalid = (code: string) => new Stripe.errors.StripeInvalidRequestError({ message: 'local', type: 'invalid_request_error', code })

describe('StripeConnectDirectProvider (Direct Charge)', () => {
  it('creates a card_present manual-capture PaymentIntent on the restaurant account without any platform fee', async () => {
    const client = stub(); client.paymentIntents.create.mockResolvedValue(intent())
    const result = await provider(client).createTerminalPaymentIntent({
      accountId: ACCOUNT, amountCents: 5000, currency: 'eur', idempotencyKey: 'cod-pay-1',
      metadata: { orderId: 'o1', merchantId: 'm1', paymentId: 'p1' }
    })
    expect(client.paymentIntents.create).toHaveBeenCalledWith(
      { amount: 5000, currency: 'eur', payment_method_types: ['card_present'], capture_method: 'manual', metadata: { order_id: 'o1', merchant_id: 'm1', payment_id: 'p1' } },
      { stripeAccount: ACCOUNT, idempotencyKey: 'cod-pay-1' }
    )
    const params = client.paymentIntents.create.mock.calls[0]![0]
    for (const forbidden of ['application_fee_amount', 'transfer_data', 'on_behalf_of', 'customer']) expect(params).not.toHaveProperty(forbidden)
    expect(result).toMatchObject({ id: 'pi_1', accountId: ACCOUNT, amountCents: 5000, hasTransferData: false, hasOnBehalfOf: false, applicationFeeAmountCents: null })
  })

  it('captures the whole PaymentIntent under the restaurant account with an idempotency key and never sends an amount', async () => {
    const client = stub(); client.paymentIntents.capture.mockResolvedValue(intent({ status: 'succeeded', amount_received: 5000 }))
    const result = await provider(client).capturePaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1', idempotencyKey: 'cod-cap-1' })
    expect(client.paymentIntents.capture).toHaveBeenCalledWith('pi_1', {}, { stripeAccount: ACCOUNT, idempotencyKey: 'cod-cap-1' })
    expect(result.amountReceivedCents).toBe(5000)
  })

  it('maps payment_intent_unexpected_state and resource_missing, keeping the cause, and wraps other Stripe errors', async () => {
    const client = stub()
    client.paymentIntents.capture.mockRejectedValueOnce(invalid('payment_intent_unexpected_state'))
    await expect(provider(client).capturePaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1', idempotencyKey: 'k' }))
      .rejects.toBeInstanceOf(PaymentIntentUnexpectedStateError)
    client.paymentIntents.retrieve.mockRejectedValueOnce(invalid('resource_missing'))
    await expect(provider(client).retrievePaymentIntent({ accountId: 'acct_b', paymentIntentId: 'pi_1' })).rejects.toBeInstanceOf(ConnectResourceMissingError)
    client.paymentIntents.cancel.mockRejectedValueOnce(invalid('parameter_invalid_integer'))
    await expect(provider(client).cancelPaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1', idempotencyKey: 'k' }))
      .rejects.toMatchObject({ constructor: ConnectProviderError, cause: expect.any(Error) })
  })

  it('reads and cancels PaymentIntents only under the given connected account', async () => {
    const client = stub(); client.paymentIntents.retrieve.mockResolvedValue(intent({ latest_charge: 'ch_1' })); client.paymentIntents.cancel.mockResolvedValue(intent({ status: 'canceled' }))
    const api = provider(client)
    expect((await api.retrievePaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1' })).chargeId).toBe('ch_1')
    await api.cancelPaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1', idempotencyKey: 'cod-cancel-1' })
    expect(client.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1', {}, { stripeAccount: ACCOUNT })
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', {}, { stripeAccount: ACCOUNT, idempotencyKey: 'cod-cancel-1' })
  })

  it('exposes platform-fee, transfer and on_behalf_of markers so callers can reject a contaminated PaymentIntent', async () => {
    const client = stub(); client.paymentIntents.retrieve.mockResolvedValue(intent({ application_fee_amount: 100, transfer_data: { destination: 'acct_x' }, on_behalf_of: 'acct_x' }))
    expect(await provider(client).retrievePaymentIntent({ accountId: ACCOUNT, paymentIntentId: 'pi_1' }))
      .toMatchObject({ applicationFeeAmountCents: 100, hasTransferData: true, hasOnBehalfOf: true })
  })

  it('creates a ConnectionToken bounded to the Location under the restaurant account', async () => {
    const client = stub(); client.terminal.connectionTokens.create.mockResolvedValue({ secret: 'pst_test_x' })
    expect(await provider(client).createConnectionToken({ accountId: ACCOUNT, locationId: 'tml_1' })).toEqual({ secret: 'pst_test_x' })
    expect(client.terminal.connectionTokens.create).toHaveBeenCalledWith({ location: 'tml_1' }, { stripeAccount: ACCOUNT })
  })

  it('reuses the Location with the same name and otherwise creates it on the restaurant account', async () => {
    const client = stub()
    client.terminal.locations.list.mockResolvedValue({ data: [{ id: 'tml_other', display_name: 'Autre' }, { id: 'tml_1', display_name: 'Restaurant A' }] })
    const address = { line1: '1 Rue', city: 'Bourg-en-Bresse', postalCode: '01000', country: 'FR' }
    expect(await provider(client).ensureTerminalLocation({ accountId: ACCOUNT, displayName: 'Restaurant A', address })).toEqual({ locationId: 'tml_1' })
    expect(client.terminal.locations.create).not.toHaveBeenCalled()
    client.terminal.locations.list.mockResolvedValue({ data: [] }); client.terminal.locations.create.mockResolvedValue({ id: 'tml_new' })
    expect(await provider(client).ensureTerminalLocation({ accountId: ACCOUNT, displayName: 'Restaurant A', address })).toEqual({ locationId: 'tml_new' })
    expect(client.terminal.locations.create).toHaveBeenCalledWith(
      { display_name: 'Restaurant A', address: { line1: '1 Rue', city: 'Bourg-en-Bresse', postal_code: '01000', country: 'FR' } },
      { stripeAccount: ACCOUNT }
    )
  })

  it('adds the merchant configuration with dashboard full, stripe/stripe responsibilities and both card capabilities', async () => {
    const client = stub(); client.v2.core.accounts.update.mockResolvedValue({})
    await provider(client).addMerchantConfiguration({ accountId: ACCOUNT })
    expect(client.v2.core.accounts.update).toHaveBeenCalledTimes(1)
    const call = client.v2.core.accounts.update.mock.calls[0]!
    expect(call[0]).toBe(ACCOUNT)
    expect(call[1]).toEqual({
      dashboard: 'full',
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true }, cartes_bancaires_payments: { requested: true } } } }
    })
    expect(call).toHaveLength(2)
  })

  it('passes an explicit v2 API version only in RequestOptions and never in the body', async () => {
    const client = stub(); client.v2.core.accounts.update.mockResolvedValue({})
    await provider(client, '2026-09-01.preview').addMerchantConfiguration({ accountId: ACCOUNT })
    const call = client.v2.core.accounts.update.mock.calls[0]!
    expect(call[2]).toEqual({ apiVersion: '2026-09-01.preview' })
    expect(JSON.stringify(call[1])).not.toContain('apiVersion')
  })

  it('creates an onboarding link for exactly the applied configurations customer + merchant', async () => {
    const client = stub(); client.v2.core.accountLinks.create.mockResolvedValue({ url: 'https://connect.stripe.com/setup/s/x', expires_at: '2026-09-20T10:00:00.000Z' })
    const link = await provider(client).createOnboardingLink({ accountId: ACCOUNT, returnUrl: 'https://app/return', refreshUrl: 'https://app/refresh' })
    expect(client.v2.core.accountLinks.create).toHaveBeenCalledWith({
      account: ACCOUNT,
      use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['customer', 'merchant'], return_url: 'https://app/return', refresh_url: 'https://app/refresh' } }
    }, {})
    expect(link).toEqual({ url: 'https://connect.stripe.com/setup/s/x', expiresAt: new Date('2026-09-20T10:00:00.000Z') })
  })

  it('derives the account status without exposing requirement contents', async () => {
    const client = stub()
    client.v2.core.accounts.retrieve.mockResolvedValue({
      applied_configurations: ['customer', 'merchant'], dashboard: 'full',
      configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, cartes_bancaires_payments: { status: 'pending' } } } },
      requirements: { entries: [{ description: 'x' }, { description: 'y' }] }
    })
    expect(await provider(client).getAccountStatus(ACCOUNT)).toEqual({
      accountId: ACCOUNT, merchantConfigured: true, dashboard: 'full', cardPayments: 'active', cartesBancaires: 'pending', requirementsCount: 2
    })
    client.v2.core.accounts.retrieve.mockResolvedValue({ applied_configurations: ['customer'], dashboard: null, configuration: { merchant: null }, requirements: { entries: [] } })
    expect(await provider(client).getAccountStatus(ACCOUNT)).toMatchObject({ merchantConfigured: false, cardPayments: 'not_requested', cartesBancaires: 'not_requested', requirementsCount: 0 })
  })

  it('rejects every operation asynchronously when Stripe is not configured', async () => {
    const unavailable = new UnavailableConnectPaymentsProvider()
    await expect(unavailable.createConnectionToken()).rejects.toBeInstanceOf(ConnectUnavailableError)
    await expect(unavailable.capturePaymentIntent()).rejects.toBeInstanceOf(ConnectUnavailableError)
  })
})
