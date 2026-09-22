import type { CreateDebitInput, DebitObservation, DebitSource, DebitSourceReader, SepaDebitProvider, SettlementLogger } from '../../src/modules/settlements/public.js'

export const silentLogger: SettlementLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

export class FakeSources implements DebitSourceReader {
  public overrides = new Map<string, DebitSource | null>()
  public async findActive(merchantId: string): Promise<DebitSource | null> {
    if (this.overrides.has(merchantId)) return this.overrides.get(merchantId)!
    const n = merchantId.slice(-1)
    return { stripeAccountId: `acct_fake_${n}`, paymentMethodId: `pm_fake_${n}`, mandateId: `mandate_fake_${n}`, mandateReference: `MANDATE-${n}` }
  }
}

export class FakeProvider implements SepaDebitProvider {
  public readonly livemode = false
  public readonly calls: CreateDebitInput[] = []
  public readonly intents = new Map<string, DebitObservation>()
  public readonly byKey = new Map<string, string>()
  public createError = new Map<string, Error>() // par restaurant (metadata.merchant_id), consommée une fois
  public alwaysError = new Map<string, Error>()
  public amountOverride: number | null = null
  public retrievals = 0
  private sequence = 0

  public async createDebit(input: CreateDebitInput): Promise<DebitObservation> {
    this.calls.push(input)
    const merchantId = input.metadata.merchant_id
    const always = this.alwaysError.get(merchantId)
    if (always !== undefined) throw always
    const once = this.createError.get(merchantId)
    if (once !== undefined) { this.createError.delete(merchantId); throw once }
    const existing = this.byKey.get(input.idempotencyKey)
    if (existing !== undefined) return this.intents.get(existing)!
    this.sequence += 1
    const observation: DebitObservation = { paymentIntentId: `pi_fake_${this.sequence}`, paymentIntentStatus: 'processing', amountCents: this.amountOverride ?? input.amountCents, currency: 'eur', livemode: false, attemptIdMetadata: input.metadata.debit_attempt_id, chargeId: `ch_fake_${this.sequence}`, chargeStatus: 'pending', paid: false, hasBalanceTransaction: false, availableOn: null, failureCode: null }
    this.intents.set(observation.paymentIntentId, observation)
    this.byKey.set(input.idempotencyKey, observation.paymentIntentId)
    return observation
  }
  public async retrieveDebit(paymentIntentId: string): Promise<DebitObservation> { this.retrievals += 1; return this.intents.get(paymentIntentId)! }
  public async findDebitByAttemptId(attemptId: string): Promise<DebitObservation | null> { return [...this.intents.values()].find((o) => o.attemptIdMetadata === attemptId) ?? null }
  public settle(piId: string, state: 'succeeded' | 'failed', failureCode = 'insufficient_funds'): void {
    const current = this.intents.get(piId)!
    this.intents.set(piId, state === 'succeeded'
      ? { ...current, paymentIntentStatus: 'succeeded', chargeStatus: 'succeeded', paid: true, hasBalanceTransaction: true, availableOn: new Date('2026-09-10T00:00:00Z') }
      : { ...current, paymentIntentStatus: 'requires_payment_method', chargeStatus: 'failed', failureCode })
  }
}

