import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { pool } from '../../src/platform/db.js'
import { PostgresMerchantRepository } from '../../src/modules/merchants/infrastructure/postgres-merchant-repository.js'
import { CompleteSepaSetupIntentUseCase, CreateSepaSetupIntentUseCase, GetSepaPaymentMethodUseCase, PaymentMethodNotReadyError, SetupAlreadyCompletedError } from '../../src/modules/payments/application/sepa-payment-method.js'
import { PostgresPaymentRepository } from '../../src/modules/payments/infrastructure/postgres-payment-repository.js'
import type { StripeProvider } from '../../src/modules/payments/ports/stripe-provider.js'

const merchants: string[] = []
const repository = new PostgresPaymentRepository(pool)
const merchantRepository = new PostgresMerchantRepository(pool)

class FakeStripe implements StripeProvider {
  accounts = 0; setups = 0; setupReads = 0; detachCalls = 0; updates = 0; merchantConfiguration = false
  intents = new Map<string, { id: string; customer_account: string; status: string; metadata: { merchant_id: string }; client_secret: string; payment_method?: string; mandate?: string }>()
  async createCustomerAccount(): Promise<{ id: string }> { this.accounts++; return { id: `acct_local_${this.accounts}` } }
  async hasMerchantConfiguration(): Promise<boolean> { return this.merchantConfiguration }
  async updateCustomerAccount(): Promise<void> { this.updates++ }
  async createSetupIntent(input: { customerAccountId: string; merchantId: string }): Promise<{ setupIntentId: string; clientSecret: string }> { const id = `seti_local_${++this.setups}`; const clientSecret = `${id}_secret_local`; this.intents.set(id, { id, customer_account: input.customerAccountId, status: 'requires_payment_method', metadata: { merchant_id: input.merchantId }, client_secret: clientSecret }); return { setupIntentId: id, clientSecret } }
  async retrieveSetupIntent(id: string): Promise<Stripe.SetupIntent> { this.setupReads++; return this.intents.get(id) as unknown as Stripe.SetupIntent }
  async retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod> { return { id, type: 'sepa_debit', customer_account: [...this.intents.values()].find((intent) => intent.payment_method === id)?.customer_account ?? 'acct_local', sepa_debit: { last4: '6789', country: 'FR' } } as unknown as Stripe.PaymentMethod }
  async retrieveMandate(id: string): Promise<Stripe.Mandate> { return { id, payment_method: `pm_${id.slice('mandate_'.length)}`, payment_method_details: { sepa_debit: { reference: 'LOCAL' } } } as unknown as Stripe.Mandate }
  async detachPaymentMethod(): Promise<void> { this.detachCalls++ }
  constructEvent(): Stripe.Event { throw new Error('not used') }
  succeed(id: string): void { const intent = this.intents.get(id); if (intent !== undefined) Object.assign(intent, { status: 'succeeded', payment_method: `pm_${id}`, mandate: `mandate_${id}` }) }
  cancel(id: string): void { const intent = this.intents.get(id); if (intent !== undefined) intent.status = 'canceled' }
}

async function merchant(): Promise<string> {
  const id = randomUUID(); merchants.push(id)
  await pool.query('insert into merchants(id, name) values ($1, $2)', [id, `Payments local ${id}`])
  await merchantRepository.upsertLegalInformation({ merchantId: id, siret: '73282932000074', siren: '732829320', legalName: 'Payments local', legalAddress: { line1: '1 Local street', line2: null, postalCode: '01000', city: 'Local', countryCode: 'FR', communeCode: null }, billingAddress: null, vatNumber: null, buyerReference: null, sireneVerificationStatus: 'verified' })
  return id
}
function useCases(stripe: FakeStripe) { const complete = new CompleteSepaSetupIntentUseCase(repository, stripe); return { create: new CreateSepaSetupIntentUseCase(repository, stripe, merchantRepository.findById.bind(merchantRepository), merchantRepository.findLegalInformation.bind(merchantRepository), complete), complete, get: new GetSepaPaymentMethodUseCase(repository) } }

afterEach(async () => { if (merchants.length > 0) await pool.query('delete from merchants where id = any($1::uuid[])', [merchants.splice(0)]) })

describe('SEPA payment flow on PostgreSQL', () => {
  it('enforces the unique Stripe Account profile identifier', async () => {
    const a = await merchant(); const b = await merchant()
    await pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values ($1, $2)', [a, 'acct_shared'])
    await expect(pool.query('insert into merchant_payment_profiles(merchant_id, stripe_account_id) values ($1, $2)', [b, 'acct_shared'])).rejects.toMatchObject({ code: '23505' })
  })
  it('creates one customer/profile under concurrent setup and a distinct profile for another merchant', async () => {
    const a = await merchant(); const b = await merchant(); const stripe = new FakeStripe(); const { create } = useCases(stripe)
    await Promise.all([create.execute(a, 'a@example.test'), create.execute(a, 'a@example.test')]); await create.execute(b, 'b@example.test')
    expect(stripe.accounts).toBe(2)
    expect((await pool.query('select merchant_id from merchant_payment_profiles where merchant_id = any($1::uuid[])', [[a, b]])).rowCount).toBe(2)
  })

  it('never persists a client secret or IBAN, and reload reuses the pending SetupIntent', async () => {
    const id = await merchant(); const stripe = new FakeStripe(); const { create } = useCases(stripe); const first = await create.execute(id, 'local@example.test'); const reload = await create.execute(id, 'local@example.test')
    expect(reload).toEqual(first); expect(stripe.setups).toBe(1)
    const [profiles, methods] = await Promise.all([pool.query('select * from merchant_payment_profiles where merchant_id = $1', [id]), pool.query('select * from merchant_payment_methods where merchant_id = $1', [id])])
    const serialized = JSON.stringify([profiles.rows, methods.rows]).toLowerCase(); expect(serialized).not.toContain('_secret_'); expect(serialized).not.toContain('iban'); expect(serialized).not.toContain('fr76')
  })
  it('creates and finalizes a SetupIntent without identity update when merchant is applied', async () => {
    const id = await merchant(); const stripe = new FakeStripe(); stripe.merchantConfiguration = true; const flows = useCases(stripe)
    const pending = await flows.create.execute(id, 'local@example.test'); stripe.succeed(pending.setupIntentId)
    const active = await flows.complete.execute(id, pending.setupIntentId)
    expect(stripe.updates).toBe(0)
    expect(active).toMatchObject({ merchantId: id, setupIntentId: pending.setupIntentId, status: 'active' })
  })

  it('reloads Stripe on completion, exposes only a summary, and prevents cross-merchant completion', async () => {
    const a = await merchant(); const b = await merchant(); const stripe = new FakeStripe(); const flows = useCases(stripe); const pending = await flows.create.execute(a, 'a@example.test'); stripe.succeed(pending.setupIntentId)
    await expect(flows.complete.execute(b, pending.setupIntentId)).rejects.toBeInstanceOf(PaymentMethodNotReadyError)
    const active = await flows.complete.execute(a, pending.setupIntentId); expect(stripe.setupReads).toBeGreaterThan(0)
    expect(await new GetSepaPaymentMethodUseCase(repository).execute(a)).toMatchObject({ status: 'active', bankName: null, last4: '6789', country: 'FR' })
    expect(await flows.get.execute(b)).toBeNull(); expect(JSON.stringify(active)).not.toContain('clientSecret')
  })

  it('keeps the old active method displayed until a successful replacement, then queues it without detaching', async () => {
    const id = await merchant(); const stripe = new FakeStripe(); const flows = useCases(stripe); const first = await flows.create.execute(id, 'local@example.test'); stripe.succeed(first.setupIntentId); await flows.complete.execute(id, first.setupIntentId)
    const canceled = await flows.create.execute(id, 'local@example.test'); stripe.cancel(canceled.setupIntentId); const replacement = await flows.create.execute(id, 'local@example.test')
    expect((await flows.get.execute(id))?.setupIntentId).toBe(first.setupIntentId)
    stripe.succeed(replacement.setupIntentId); await flows.complete.execute(id, replacement.setupIntentId)
    expect((await flows.get.execute(id))?.setupIntentId).toBe(replacement.setupIntentId); expect(stripe.detachCalls).toBe(0)
    expect((await pool.query("select status from merchant_payment_methods where merchant_id = $1 and stripe_setup_intent_id = $2", [id, first.setupIntentId])).rows[0]?.status).toBe('detach_pending')
  })

  it('finalizes an already succeeded pending SetupIntent then reports it as already completed without changing onboarding', async () => {
    const id = await merchant(); const stripe = new FakeStripe(); const flows = useCases(stripe); const pending = await flows.create.execute(id, 'local@example.test'); stripe.succeed(pending.setupIntentId)
    await expect(flows.create.execute(id, 'local@example.test')).rejects.toBeInstanceOf(SetupAlreadyCompletedError)
    expect((await repository.findActive(id))?.setupIntentId).toBe(pending.setupIntentId)
    expect((await pool.query<{ onboarding_completed: boolean }>('select onboarding_completed from merchants where id = $1', [id])).rows[0]?.onboarding_completed).toBe(false)
  })
})
