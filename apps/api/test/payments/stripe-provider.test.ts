import Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { StripeApiProvider, UnavailableStripeProvider } from '../../src/modules/payments/infrastructure/stripe-provider.js'
import { createStripeProvider } from '../../src/modules/payments/public.js'
import { StripeAccountTokenRequiredError, StripeIdempotencyConflictError, StripeProviderError, StripeUnavailableError, type StripeProvider } from '../../src/modules/payments/ports/stripe-provider.js'

const key = 'local-only-key-placeholder'; const webhook = 'local-only-signing-value'
type Stub = { v2: { core: { accounts: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } } }; setupIntents: { create: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> }; paymentMethods: { retrieve: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }; mandates: { retrieve: ReturnType<typeof vi.fn> } }
const stub = (): Stub => ({ v2: { core: { accounts: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() } } }, setupIntents: { create: vi.fn(), retrieve: vi.fn() }, paymentMethods: { retrieve: vi.fn(), detach: vi.fn() }, mandates: { retrieve: vi.fn() } })
const provider = (client: Stub, version?: string) => new StripeApiProvider(key, webhook, client as unknown as Stripe, version)
// Vrai client Stripe, transport HTTP factice : on observe ce qui part réellement (en-tête Stripe-Version, corps).
function capturingClient(): { client: Stripe; requests: Array<{ path: string; version: string | null; body: string }> } {
  const requests: Array<{ path: string; version: string | null; body: string }> = []
  const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, version: new Headers(init?.headers).get('stripe-version'), body: String(init?.body ?? '') })
    return new Response(JSON.stringify({ id: 'acct_local', client_secret: 'local-secret' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { client: new Stripe(key, { httpClient, maxNetworkRetries: 0 }), requests }
}
const invalid = (code: string) => new Stripe.errors.StripeInvalidRequestError({ message: 'local error', code })

describe('StripeApiProvider', () => {
  it('constructs its Stripe client with the bounded network policy', () => {
    const api = new StripeApiProvider(key, webhook)
    const client = (api as unknown as { stripe: { _api: { timeout: number; maxNetworkRetries: number } } }).stripe
    expect(client._api).toMatchObject({ timeout: 20_000, maxNetworkRetries: 2 })
  })
  it('creates only the minimal customer-configured Account and uses v2 idempotency options', async () => {
    const client = stub(); client.v2.core.accounts.create.mockResolvedValue({ id: 'acct_local' })
    await expect(provider(client).createCustomerAccount({ merchantId: 'merchant-local' })).resolves.toEqual({ id: 'acct_local' })
    expect(client.v2.core.accounts.create).toHaveBeenCalledWith({ configuration: { customer: {} }, metadata: { merchant_id: 'merchant-local' } }, { idempotencyKey: 'merchant-customer-account-merchant-local' })
    expect(client.v2.core.accounts.create.mock.calls[0]![1]).not.toHaveProperty('apiVersion')
    const params = client.v2.core.accounts.create.mock.calls[0]![0]
    expect(Object.keys(params.configuration)).toEqual(['customer'])
    for (const forbidden of ['dashboard', 'defaults', 'identity', 'contact_email', 'display_name']) expect(params).not.toHaveProperty(forbidden)
  })
  it.each([
    { line2: '', expectedLine2: undefined },
    { line2: '   ', expectedLine2: undefined },
    { line2: ' Bât. A ', expectedLine2: 'Bât. A' }
  ])('updates Account identity and normalizes line2 %#', async ({ line2, expectedLine2 }) => {
    const client = stub(); client.v2.core.accounts.update.mockResolvedValue({})
    await provider(client).updateCustomerAccount('acct_local', { email: 'local@example.test', legalName: 'Local restaurant', address: { line1: '1 Local street', line2, city: 'Local', postalCode: '01000', countryCode: 'FR' } })
    const address = client.v2.core.accounts.update.mock.calls[0]![1].identity.business_details.address
    expect(client.v2.core.accounts.update).toHaveBeenCalledWith('acct_local', { contact_email: 'local@example.test', display_name: 'Local restaurant', identity: { country: 'fr', entity_type: 'company', business_details: { registered_name: 'Local restaurant', address: { line1: '1 Local street', ...(expectedLine2 === undefined ? {} : { line2: expectedLine2 }), city: 'Local', postal_code: '01000', country: 'fr' } } } })
    expect(address).toHaveProperty('line1', '1 Local street')
    expect(address).toHaveProperty('city', 'Local')
    expect(address).toHaveProperty('postal_code', '01000')
    expect(address).toHaveProperty('country', 'fr')
    if (expectedLine2 === undefined) expect(address).not.toHaveProperty('line2')
    else expect(address).toHaveProperty('line2', expectedLine2)
    expect(client.v2.core.accounts.update.mock.calls[0]).toHaveLength(2)
  })
  it('uses the configured v2 version only for Account calls', async () => {
    const client = stub(); client.v2.core.accounts.create.mockResolvedValue({ id: 'acct_local' }); client.setupIntents.create.mockResolvedValue({ id: 'seti_local', client_secret: 'secret' })
    const api = provider(client, '2026-09-01.preview'); await api.createCustomerAccount({ merchantId: 'merchant-local' }); await api.createSetupIntent({ customerAccountId: 'acct_local', merchantId: 'merchant-local' })
    expect(client.v2.core.accounts.create.mock.calls[0]![1]).toMatchObject({ apiVersion: '2026-09-01.preview' }); expect(client.setupIntents.create.mock.calls[0]).toHaveLength(1)
  })
  it.each([
    { appliedConfigurations: ['customer', 'merchant'], expected: true },
    { appliedConfigurations: ['customer'], expected: false }
  ])('detects merchant configuration %#', async ({ appliedConfigurations, expected }) => {
    const client = stub(); client.v2.core.accounts.retrieve.mockResolvedValue({ applied_configurations: appliedConfigurations })
    await expect(provider(client).hasMerchantConfiguration('acct_local')).resolves.toBe(expected)
    expect(client.v2.core.accounts.retrieve).toHaveBeenCalledWith('acct_local')
  })
  it('uses configured version only in retrieve options', async () => {
    const client = stub(); client.v2.core.accounts.retrieve.mockResolvedValue({ applied_configurations: [] })
    await provider(client, '2026-09-01.preview').hasMerchantConfiguration('acct_local')
    expect(client.v2.core.accounts.retrieve).toHaveBeenCalledWith('acct_local', {}, { apiVersion: '2026-09-01.preview' })
  })
  it('detects merchant configuration with a version override', async () => {
    const client = stub(); client.v2.core.accounts.retrieve.mockResolvedValue({ applied_configurations: ['customer', 'merchant'] })
    await expect(provider(client, '2026-09-01.preview').hasMerchantConfiguration('acct_local')).resolves.toBe(true)
  })
  it('passes an explicit v2 version only in RequestOptions and never in the Account params', async () => {
    const client = stub(); client.v2.core.accounts.create.mockResolvedValue({ id: 'acct_local' }); client.v2.core.accounts.update.mockResolvedValue({})
    const api = provider(client, '2026-09-01.preview')
    await api.createCustomerAccount({ merchantId: 'merchant-local' })
    await api.updateCustomerAccount('acct_local', { email: 'local@example.test', legalName: 'Local restaurant', address: { line1: '1 Local street', line2: '', city: 'Local', postalCode: '01000', countryCode: 'FR' } })
    expect(client.v2.core.accounts.create.mock.calls[0]![1]).toEqual({ apiVersion: '2026-09-01.preview', idempotencyKey: 'merchant-customer-account-merchant-local' })
    expect(client.v2.core.accounts.update.mock.calls[0]![2]).toEqual({ apiVersion: '2026-09-01.preview' })
    for (const params of [client.v2.core.accounts.create.mock.calls[0]![0], client.v2.core.accounts.update.mock.calls[0]![1]]) expect(JSON.stringify(params)).not.toContain('apiVersion')
  })
  it('sends no explicit API version to Accounts v2 when none is configured, and never puts one in the body', async () => {
    const { client, requests } = capturingClient()
    const api = new StripeApiProvider(key, webhook, client)
    await api.createCustomerAccount({ merchantId: 'merchant-local' })
    await api.updateCustomerAccount('acct_local', { email: 'local@example.test', legalName: 'Local restaurant', address: { line1: '1 Local street', line2: '', city: 'Local', postalCode: '01000', countryCode: 'FR' } })
    expect(requests.map((request) => request.path)).toEqual(['/v2/core/accounts', '/v2/core/accounts/acct_local'])
    for (const request of requests) { expect(request.version).toBe(Stripe.API_VERSION); expect(request.version).not.toContain('preview'); expect(request.body).not.toContain('apiVersion') }
  })
  it('sends an explicit override as Stripe-Version on Accounts v2 only, never in the body', async () => {
    const { client, requests } = capturingClient()
    const api = new StripeApiProvider(key, webhook, client, '2026-09-01.preview')
    await api.createCustomerAccount({ merchantId: 'merchant-local' })
    await api.updateCustomerAccount('acct_local', { email: 'local@example.test', legalName: 'Local restaurant', address: { line1: '1 Local street', line2: '', city: 'Local', postalCode: '01000', countryCode: 'FR' } })
    await api.createSetupIntent({ customerAccountId: 'acct_local', merchantId: 'merchant-local' })
    expect(requests.map((request) => request.version)).toEqual(['2026-09-01.preview', '2026-09-01.preview', Stripe.API_VERSION])
    for (const request of requests) expect(request.body).not.toContain('apiVersion')
  })
  it('wires the optional override through createStripeProvider without imposing a default', () => {
    expect((createStripeProvider(true, key, webhook) as unknown as { accountsV2ApiVersion?: string }).accountsV2ApiVersion).toBeUndefined()
    expect((createStripeProvider(true, key, webhook, '2026-09-01.preview') as unknown as { accountsV2ApiVersion?: string }).accountsV2ApiVersion).toBe('2026-09-01.preview')
  })
  it('creates a SEPA SetupIntent against customer_account, never customer', async () => {
    const client = stub(); client.setupIntents.create.mockResolvedValue({ id: 'seti_local', client_secret: 'secret' })
    await provider(client).createSetupIntent({ customerAccountId: 'acct_local', merchantId: 'merchant-local' })
    expect(client.setupIntents.create).toHaveBeenCalledWith({ customer_account: 'acct_local', allowed_payment_method_types: ['sepa_debit'], usage: 'off_session', metadata: { merchant_id: 'merchant-local' } }); expect(client.setupIntents.create.mock.calls[0]![0]).not.toHaveProperty('customer')
  })
  it('maps v2 idempotency and SDK errors while preserving their cause', async () => {
    const client = stub(); const conflict = new Stripe.errors.StripeIdempotencyError({ message: 'local error' }); client.v2.core.accounts.create.mockRejectedValueOnce(conflict)
    await expect(provider(client).createCustomerAccount({ merchantId: 'merchant-local' })).rejects.toBeInstanceOf(StripeIdempotencyConflictError)
    client.v2.core.accounts.update.mockRejectedValueOnce(invalid('other'))
    await expect(provider(client).updateCustomerAccount('acct_local', { email: 'a@test', legalName: 'A', address: { line1: '1', line2: '', city: 'A', postalCode: '1', countryCode: 'FR' } })).rejects.toMatchObject({ cause: expect.any(Error) })
  })
  it('maps only account_token_required to its typed error', async () => {
    const client = stub(); const tokenRequired = invalid('account_token_required'); client.v2.core.accounts.update.mockRejectedValueOnce(tokenRequired)
    await expect(provider(client).updateCustomerAccount('acct_local', { email: 'a@test', legalName: 'A', address: { line1: '1', line2: '', city: 'A', postalCode: '1', countryCode: 'FR' } })).rejects.toMatchObject({ constructor: StripeAccountTokenRequiredError, cause: tokenRequired })
    client.v2.core.accounts.update.mockRejectedValueOnce(invalid('invalid_fields'))
    await expect(provider(client).updateCustomerAccount('acct_local', { email: 'a@test', legalName: 'A', address: { line1: '1', line2: '', city: 'A', postalCode: '1', countryCode: 'FR' } })).rejects.toBeInstanceOf(StripeProviderError)
  })
  it('uses asynchronous unavailable rejections', async () => {
    const unavailable: StripeProvider = new UnavailableStripeProvider()
    await expect(unavailable.createCustomerAccount({ merchantId: 'merchant-local' })).rejects.toBeInstanceOf(StripeUnavailableError)
    await expect(unavailable.hasMerchantConfiguration('acct_local')).rejects.toBeInstanceOf(StripeUnavailableError)
    await expect(unavailable.updateCustomerAccount('acct_local', { email: 'a@test', legalName: 'A', address: { line1: '1', line2: '', city: 'A', postalCode: '1', countryCode: 'FR' } })).rejects.toBeInstanceOf(StripeUnavailableError)
    expect(() => unavailable.constructEvent('{}', 'signature')).toThrow(StripeUnavailableError)
  })
})
