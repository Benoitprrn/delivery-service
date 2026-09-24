import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { MerchantLegalInformation } from '../../src/modules/merchants/public.js'
import { CompleteSepaSetupIntentUseCase, CreateSepaSetupIntentUseCase, HandleStripeWebhookUseCase, PaymentMethodNotReadyError, SetupAlreadyCompletedError, SetupProcessingError, SetupStatusUnsupportedError, StripeSetupFailedError, UnknownSetupIntentError } from '../../src/modules/payments/application/sepa-payment-method.js'
import { ReconcileDetachmentsUseCase } from '../../src/modules/payments/application/reconcile-detachments.js'
import { startStripePaymentsWorker } from '../../src/modules/payments/public.js'
import type { ActivePaymentMethod, MerchantPaymentMethod, MerchantPaymentProfile, PaymentRepository, StoredStripeWebhookEvent } from '../../src/modules/payments/ports/payment-repository.js'
import { StripeAccountTokenRequiredError, StripeIdempotencyConflictError, StripeProviderError, StripeResourceMissingError, type StripeProvider } from '../../src/modules/payments/ports/stripe-provider.js'
import type { PaymentsLogger } from '../../src/modules/payments/ports/payments-logger.js'

const legal: MerchantLegalInformation = { merchantId:'merchant-a',siret:'73282932000074',siren:'732829320',legalName:'Restaurant A SAS',legalAddress:{line1:'1 rue Test',line2:null,postalCode:'01000',city:'Bourg-en-Bresse',countryCode:'FR',communeCode:null},billingAddress:{line1:'2 rue Facturation',line2:null,postalCode:'69001',city:'Lyon',countryCode:'FR',communeCode:null},vatNumber:null,buyerReference:null,sireneVerificationStatus:'verified',sireneVerifiedAt:null }

const merchant = { id:'merchant-a', name:'Restaurant A', zoneId:null,address:null,phonePrimary:null,phoneSecondary:null,logoUrl:null,lat:null,lng:null,onboardingCompleted:false }
function method(id:string, merchantId='merchant-a', status:MerchantPaymentMethod['status']='setup_pending'):MerchantPaymentMethod { return {id,merchantId,setupIntentId:`seti_${id}`,stripePaymentMethodId:status==='active'?`pm_${id}`:null,stripeMandateId:status==='active'?`mandate_${id}`:null,status,bankName:null,last4:null,country:null,mandateReference:null,activatedAt:null,invalidatedAt:null} }
class MemoryRepository implements PaymentRepository {
  profiles=new Map<string,MerchantPaymentProfile>(); methods=new Map<string,MerchantPaymentMethod>(); events=new Map<string,{event:StoredStripeWebhookEvent;status:'pending'|'processing'|'processed'|'failed'|'dead_letter';token:string;attempts:number;errorClass:string|null}>(); detached:string[]=[]; failedWebhook: {eventId:string;token:string;errorClass:string}[]=[]; detachFailures: {paymentMethodId:string;token:string;errorClass:string}[]=[]; detachClaims: {paymentMethodId:string;token:string}[]=[]
  async findProfile(id:string){return this.profiles.get(id)??null}; async saveProfile(p:MerchantPaymentProfile){const existing=this.profiles.get(p.merchantId);if(existing!==undefined)return existing;this.profiles.set(p.merchantId,p);return p}
  async findActive(id:string){return [...this.methods.values()].find(m=>m.merchantId===id&&m.status==='active') as ActivePaymentMethod??null}; async findBySetupIntent(id:string){return this.methods.get(id)??null}
  async findDisplayMethod(id:string){return (await this.findActive(id))??[...this.methods.values()].find(m=>m.merchantId===id&&m.status==='invalid')??null}
  async findPending(id:string){return [...this.methods.values()].find(m=>m.merchantId===id&&m.status==='setup_pending')??null}
  async createPending(merchantId:string,setupIntentId:string){const existing=this.methods.get(setupIntentId);if(existing!==undefined)return existing;const item=method(setupIntentId.replace('seti_',''),merchantId);item.setupIntentId=setupIntentId;this.methods.set(setupIntentId,item);return item}
  async invalidatePending(id:string){const m=this.methods.get(id);if(m?.status==='setup_pending'){m.status='invalid';m.invalidatedAt=new Date()}}
  async activate(id:string,details:Omit<MerchantPaymentMethod,'id'|'merchantId'|'setupIntentId'|'status'|'activatedAt'|'invalidatedAt'>){const next=this.methods.get(id);if(next===undefined)throw new Error('not pending');if(next.status==='active')return{active:next as ActivePaymentMethod,previous:null};if(next.status!=='setup_pending')throw new Error('not pending');const previous=await this.findActive(next.merchantId);if(previous!==null)(previous as MerchantPaymentMethod).status='detach_pending';Object.assign(next,details,{status:'active',activatedAt:new Date()});return{active:next as ActivePaymentMethod,previous}}
  async markDetached(id:string){this.detached.push(id);for(const m of this.methods.values())if(m.stripePaymentMethodId===id&&m.status==='detach_pending')m.status='detached';else if(m.stripePaymentMethodId===id&&m.status==='active')m.status='invalid'}; async markMandateInactive(id:string){for(const m of this.methods.values())if(m.stripeMandateId===id&&m.status==='active')m.status='invalid'}; async claimDetachPending(limit:number){return this.detachClaims.splice(0,limit)}; async recordDetachFailure(failure:{paymentMethodId:string;token:string;errorClass:string}){this.detachFailures.push(failure);return true}; async recordWebhookEvent(event:StoredStripeWebhookEvent){if(!this.events.has(event.eventId))this.events.set(event.eventId,{event,status:'pending',token:'',attempts:0,errorClass:null})}; async claimNextWebhookEvent(){const current=[...this.events.values()].find(value=>value.status==='pending');if(current===undefined)return null;const token=`${current.event.eventId}-${Math.random()}`;current.status='processing';current.token=token;return{event:current.event,token}}; async completeWebhookEvent(id:string,token:string){const current=this.events.get(id);if(current?.status!=='processing'||current.token!==token)return false;current.status='processed';return true}; async failWebhookEvent(failure:{eventId:string;token:string;errorClass:string}){const current=this.events.get(failure.eventId);if(current?.status!=='processing'||current.token!==failure.token)return false;this.failedWebhook.push(failure);current.attempts++;current.errorClass=failure.errorClass;current.status=current.attempts>=20?'dead_letter':'failed';return true}
}
class FakeStripe implements StripeProvider {
  accounts=0; setups=0; setupRetrievals=0; detachCalls:string[]=[]; failDetach=false; intents=new Map<string, {id:string;customer_account:string;status:string;metadata:{merchant_id:string};client_secret:string;payment_method?:string;mandate?:string}>(); accountInputs: { merchantId: string }[]=[]; accountId='acct_a'; paymentMethodAccount='acct_a'; paymentMethodType='sepa_debit'; mandatePaymentMethod: string | null = null; createFailures: Error[]=[]
  updates:unknown[]=[]; merchantConfiguration=false; merchantConfigurationFailure: Error | null = null; updateFailure: Error | null = null; async createCustomerAccount(input:{merchantId:string}){this.accounts++;this.accountInputs.push(input);const failure=this.createFailures.shift();if(failure!==undefined)throw failure;return{id:this.accountId}}; async hasMerchantConfiguration(){if(this.merchantConfigurationFailure!==null)throw this.merchantConfigurationFailure;return this.merchantConfiguration}; async updateCustomerAccount(id:string,details:unknown){this.updates.push({id,details});if(this.updateFailure!==null)throw this.updateFailure}; async createSetupIntent(input:{customerAccountId:string;merchantId:string}){const id=`seti_${++this.setups}`;this.intents.set(id,{id,customer_account:input.customerAccountId,status:'requires_payment_method',metadata:{merchant_id:input.merchantId},client_secret:`${id}_secret_private`});return{setupIntentId:id,clientSecret:`${id}_secret_private`}}
  async retrieveSetupIntent(id:string):Promise<Stripe.SetupIntent>{this.setupRetrievals++;return this.intents.get(id) as unknown as Stripe.SetupIntent}; async retrievePaymentMethod(id:string):Promise<Stripe.PaymentMethod>{return{id,type:this.paymentMethodType,customer_account:this.paymentMethodAccount,sepa_debit:{bank_name:'Banque Test',last4:'6789',country:'FR'}} as unknown as Stripe.PaymentMethod}; async retrieveMandate(id:string):Promise<Stripe.Mandate>{return{id,payment_method:this.mandatePaymentMethod??`pm_${id.replace('mandate_','')}`,payment_method_details:{sepa_debit:{reference:'REF'}}} as unknown as Stripe.Mandate}; async detachPaymentMethod(id:string){this.detachCalls.push(id);if(this.failDetach)throw new Error('detach failed')}; constructEvent(_payload:string|Buffer,_signature:string):never{throw new Error('not used')}
  succeed(id:string){const intent=this.intents.get(id);if(intent!==undefined)Object.assign(intent,{status:'succeeded',payment_method:`pm_${id}`,mandate:`mandate_${id}`})}
}
function create(options: { sleep?: (milliseconds: number) => Promise<void>; logger?: PaymentsLogger } = {}) {const repository=new MemoryRepository();const stripe=new FakeStripe();const complete=new CompleteSepaSetupIntentUseCase(repository,stripe);const setup=new CreateSepaSetupIntentUseCase(repository,stripe,async()=>merchant,async()=>legal,complete,options.sleep,options.logger);return{repository,stripe,setup,complete}}
function stripeEvent(id:string,type:string,object:Record<string,unknown>):Stripe.Event { return { id, type, data: { object } } as unknown as Stripe.Event }

describe('SEPA payment method',()=>{
  it('creates one Account under concurrent setup requests, then synchronizes billing details, and stores no secret',async()=>{const {repository,stripe,setup}=create();const [a,b]=await Promise.all([setup.execute('merchant-a','a@test.fr'),setup.execute('merchant-a','a@test.fr')]);expect(stripe.accounts).toBe(1);expect(stripe.accountInputs).toEqual([{merchantId:'merchant-a'}]);expect(stripe.updates).toEqual([{id:'acct_a',details:{legalName:'Restaurant A SAS',email:'a@test.fr',address:{line1:'2 rue Facturation',line2:'',postalCode:'69001',city:'Lyon',countryCode:'FR'}}},{id:'acct_a',details:{legalName:'Restaurant A SAS',email:'a@test.fr',address:{line1:'2 rue Facturation',line2:'',postalCode:'69001',city:'Lyon',countryCode:'FR'}}}]);expect(repository.profiles.get('merchant-a')?.stripeAccountId).toBe('acct_a');expect(JSON.stringify([...repository.methods.values()])).not.toContain('secret');expect(a.clientSecret).toContain('secret');expect(b.clientSecret).toContain('secret')})
  it('reuses a pending SetupIntent after a browser reload',async()=>{const {repository,stripe,setup}=create();const first=await setup.execute('merchant-a','a@test.fr');const reloaded=await setup.execute('merchant-a','a@test.fr');expect(reloaded).toEqual(first);expect(stripe.setups).toBe(1);expect([...repository.methods.values()].filter((value)=>value.status==='setup_pending')).toHaveLength(1)})
  it.each(['requires_confirmation', 'requires_action'] as const)('reuses a pending SetupIntent in %s without creating a row or intent', async (status) => {
    const { repository, stripe, setup } = create()
    const first = await setup.execute('merchant-a', 'a@test.fr')
    stripe.intents.get(first.setupIntentId)!.status = status
    await expect(setup.execute('merchant-a', 'a@test.fr')).resolves.toEqual(first)
    expect(stripe.setups).toBe(1)
    expect([...repository.methods.values()]).toHaveLength(1)
  })
  it('rejects a pending SetupIntent that is still processing', async () => {
    const { stripe, setup } = create()
    const first = await setup.execute('merchant-a', 'a@test.fr')
    stripe.intents.get(first.setupIntentId)!.status = 'processing'
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(SetupProcessingError)
    expect(stripe.setups).toBe(1)
  })
  it('finalizes a succeeded pending SetupIntent before reporting it already completed', async () => {
    const { repository, stripe, setup } = create()
    const first = await setup.execute('merchant-a', 'a@test.fr')
    stripe.succeed(first.setupIntentId)
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(SetupAlreadyCompletedError)
    expect((await repository.findBySetupIntent(first.setupIntentId))?.status).toBe('active')
  })
  it('invalidates a canceled pending SetupIntent before creating its replacement', async () => {
    const { repository, stripe, setup } = create()
    const first = await setup.execute('merchant-a', 'a@test.fr')
    stripe.intents.get(first.setupIntentId)!.status = 'canceled'
    const replacement = await setup.execute('merchant-a', 'a@test.fr')
    expect((await repository.findBySetupIntent(first.setupIntentId))?.status).toBe('invalid')
    expect(replacement.setupIntentId).not.toBe(first.setupIntentId)
  })
  it('keeps an unsupported pending SetupIntent intact', async () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
    const { repository, stripe, setup } = create({ logger })
    const first = await setup.execute('merchant-a', 'a@test.fr')
    stripe.intents.get(first.setupIntentId)!.status = 'unexpected_status'
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(SetupStatusUnsupportedError)
    expect((await repository.findBySetupIntent(first.setupIntentId))?.status).toBe('setup_pending')
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ setupIntentId: first.setupIntentId }), expect.any(String))
  })
  it('synchronizes an Account before each SetupIntent without creating another one',async()=>{const {stripe,setup}=create();await setup.execute('merchant-a','a@test.fr');await setup.execute('merchant-a','updated@test.fr');expect(stripe.accounts).toBe(1);expect(stripe.updates).toEqual([{id:'acct_a',details:{legalName:'Restaurant A SAS',email:'a@test.fr',address:{line1:'2 rue Facturation',line2:'',postalCode:'69001',city:'Lyon',countryCode:'FR'}}},{id:'acct_a',details:{legalName:'Restaurant A SAS',email:'updated@test.fr',address:{line1:'2 rue Facturation',line2:'',postalCode:'69001',city:'Lyon',countryCode:'FR'}}}])})
  it('creates a SetupIntent without updating identity when merchant is applied', async () => {
    const { stripe, setup } = create()
    stripe.merchantConfiguration = true
    await expect(setup.execute('merchant-a', 'a@test.fr')).resolves.toMatchObject({ setupIntentId: expect.any(String) })
    expect(stripe.updates).toEqual([])
    expect(stripe.setups).toBe(1)
  })
  it('continues after account_token_required race while creating a SetupIntent', async () => {
    const { stripe, setup } = create()
    stripe.updateFailure = new StripeAccountTokenRequiredError()
    await expect(setup.execute('merchant-a', 'a@test.fr')).resolves.toMatchObject({ setupIntentId: expect.any(String) })
    expect(stripe.updates).toHaveLength(1)
    expect(stripe.setups).toBe(1)
  })
  it('propagates another update failure without creating a SetupIntent', async () => {
    const { stripe, setup } = create()
    stripe.updateFailure = new StripeProviderError()
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(StripeProviderError)
    expect(stripe.setups).toBe(0)
  })
  it('propagates merchant configuration lookup failure without updating or creating a SetupIntent', async () => {
    const { stripe, setup } = create()
    stripe.merchantConfigurationFailure = new StripeProviderError()
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(StripeProviderError)
    expect(stripe.updates).toEqual([])
    expect(stripe.setups).toBe(0)
  })
  it('clears line2 when synchronizing an existing Account', async () => {
    const { stripe, setup } = create()
    await setup.execute('merchant-a', 'a@test.fr')
    await setup.execute('merchant-a', 'a@test.fr')
    expect(stripe.updates[1]).toMatchObject({ details: { address: { line2: '' } } })
  })
  it('synchronizes changed legal identity and falls back to the legal address', async () => {
    const originalName = legal.legalName
    const originalBillingAddress = legal.billingAddress
    const { stripe, setup } = create()
    await setup.execute('merchant-a', 'a@test.fr')
    legal.legalName = 'Restaurant A Nouveau'
    legal.billingAddress = null
    await setup.execute('merchant-a', 'new@test.fr')
    expect(stripe.updates[1]).toMatchObject({ details: { legalName: 'Restaurant A Nouveau', email: 'new@test.fr', address: { line1: '1 rue Test' } } })
    legal.legalName = originalName
    legal.billingAddress = originalBillingAddress
  })
  it('warns when saving a newly created Account retains another profile', async () => {
    const logger: PaymentsLogger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }
    const { repository, setup } = create({ logger })
    repository.saveProfile = async (profile) => ({ ...profile, stripeAccountId: 'acct_kept' })
    await setup.execute('merchant-a', 'a@test.fr')
    expect(logger.warn).toHaveBeenCalledWith({ merchantId: 'merchant-a', createdAccountId: 'acct_a', keptAccountId: 'acct_kept' }, 'Orphan Stripe customer Account created')
  })
  it('recreates a local profile with stable Account input and synchronizes changed legal details after a save failure', async () => {
    const originalName = legal.legalName
    const originalBillingAddress = legal.billingAddress
    const { repository, stripe, setup } = create()
    let failOnce = true
    repository.saveProfile = async (profile) => {
      if (failOnce) { failOnce = false; throw new Error('database unavailable') }
      repository.profiles.set(profile.merchantId, profile)
      return profile
    }
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toThrow('database unavailable')
    legal.legalName = 'Restaurant A Corrigé'
    legal.billingAddress = null
    await setup.execute('merchant-a', 'corrected@test.fr')
    expect(stripe.accountInputs).toEqual([{ merchantId: 'merchant-a' }, { merchantId: 'merchant-a' }])
    expect(stripe.accountInputs[1]).toEqual(stripe.accountInputs[0])
    expect(stripe.updates).toEqual([{ id: 'acct_a', details: { legalName: 'Restaurant A Corrigé', email: 'corrected@test.fr', address: { line1: '1 rue Test', line2: '', postalCode: '01000', city: 'Bourg-en-Bresse', countryCode: 'FR' } } }])
    legal.legalName = originalName
    legal.billingAddress = originalBillingAddress
  })
  it('retries an idempotency conflict only after observing no saved profile', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined)
    const { repository, stripe, setup } = create({ sleep })
    stripe.createFailures.push(new StripeIdempotencyConflictError())
    sleep.mockImplementationOnce(async () => { repository.profiles.set('merchant-a', { merchantId: 'merchant-a', stripeAccountId: 'acct_saved' }) })
    await setup.execute('merchant-a', 'a@test.fr')
    expect(stripe.accounts).toBe(1)
    expect(sleep).toHaveBeenCalledWith(100)
  })
  it('rethrows after exhausting idempotency conflicts', async () => {
    const { stripe, setup } = create({ sleep: async () => undefined })
    stripe.createFailures.push(new StripeIdempotencyConflictError(), new StripeIdempotencyConflictError(), new StripeIdempotencyConflictError(), new StripeIdempotencyConflictError())
    await expect(setup.execute('merchant-a', 'a@test.fr')).rejects.toBeInstanceOf(StripeIdempotencyConflictError)
    expect(stripe.accounts).toBe(4)
  })
  it('persists a verified event before deferred processing and retries a failed claim',async()=>{const {repository,stripe,setup,complete}=create();const created=await setup.execute('merchant-a','a@test.fr');const webhook=new HandleStripeWebhookUseCase(repository,complete);await webhook.receive(stripeEvent('evt_deferred','setup_intent.succeeded',{id:created.setupIntentId,metadata:{merchant_id:'merchant-a'}}));expect(await repository.findActive('merchant-a')).toBeNull();await webhook.processBatch();expect(repository.events.get('evt_deferred')?.status).toBe('failed');stripe.succeed(created.setupIntentId);repository.events.get('evt_deferred')!.status='pending';await webhook.processBatch();expect(repository.events.get('evt_deferred')?.status).toBe('processed');expect((await repository.findActive('merchant-a'))?.setupIntentId).toBe(created.setupIntentId)})
  it('isolates merchants and completes only the expected setup',async()=>{const {repository,stripe,setup,complete}=create();const a=await setup.execute('merchant-a','a@test.fr');stripe.succeed(a.setupIntentId);await expect(complete.execute('merchant-b',a.setupIntentId)).rejects.toBeInstanceOf(PaymentMethodNotReadyError);expect(await repository.findActive('merchant-a')).toBeNull()})
  it('returns an already active local method without reading Stripe', async () => {
    const { stripe, setup, complete } = create()
    const created = await setup.execute('merchant-a', 'a@test.fr')
    stripe.succeed(created.setupIntentId)
    await complete.execute('merchant-a', created.setupIntentId)
    const reads = stripe.setupRetrievals
    await expect(complete.execute('merchant-a', created.setupIntentId)).resolves.toMatchObject({ status: 'active' })
    expect(stripe.setupRetrievals).toBe(reads)
  })
  it.each(['invalid', 'detach_pending', 'detached'] as const)('rejects a locally %s method without reading Stripe', async (status) => {
    const { repository, stripe, complete } = create()
    const local = method('unready', 'merchant-a', status)
    repository.methods.set(local.setupIntentId, local)
    await expect(complete.execute('merchant-a', local.setupIntentId)).rejects.toBeInstanceOf(PaymentMethodNotReadyError)
    expect(stripe.setupRetrievals).toBe(0)
  })
  it('distinguishes processing and failed SetupIntents', async () => {
    const { stripe, setup, complete } = create()
    const created = await setup.execute('merchant-a', 'a@test.fr')
    stripe.intents.get(created.setupIntentId)!.status = 'processing'
    await expect(complete.execute('merchant-a', created.setupIntentId)).rejects.toBeInstanceOf(SetupProcessingError)
    stripe.intents.get(created.setupIntentId)!.status = 'requires_action'
    await expect(complete.execute('merchant-a', created.setupIntentId)).rejects.toBeInstanceOf(StripeSetupFailedError)
  })
  it.each([
    ['a SetupIntent on another Account', (stripe: FakeStripe, id: string) => { stripe.intents.get(id)!.customer_account = 'acct_other' }],
    ['a SetupIntent for another merchant', (stripe: FakeStripe, id: string) => { stripe.intents.get(id)!.metadata.merchant_id = 'merchant-other' }],
    ['a PaymentMethod on another Account', (stripe: FakeStripe) => { stripe.paymentMethodAccount = 'acct_other' }],
    ['a non-SEPA PaymentMethod', (stripe: FakeStripe) => { stripe.paymentMethodType = 'card' }],
    ['a mandate for another PaymentMethod', (stripe: FakeStripe) => { stripe.mandatePaymentMethod = 'pm_other' }]
  ])('refuses %s during completion', async (_label, mutate) => {
    const { stripe, setup, complete } = create(); const created = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(created.setupIntentId); mutate(stripe, created.setupIntentId)
    await expect(complete.execute('merchant-a', created.setupIntentId)).rejects.toBeInstanceOf(StripeSetupFailedError)
  })
  it('completes from Stripe authority and is idempotent across webhook then complete',async()=>{const {repository,stripe,setup,complete}=create();const created=await setup.execute('merchant-a','a@test.fr');stripe.succeed(created.setupIntentId);const webhook=new HandleStripeWebhookUseCase(repository,complete);await webhook.receive(stripeEvent('evt_1','setup_intent.succeeded',stripe.intents.get(created.setupIntentId)??{}));await webhook.processBatch();const active=await complete.execute('merchant-a',created.setupIntentId);expect(active.status).toBe('active');expect(active.last4).toBe('6789');await webhook.receive(stripeEvent('evt_1','setup_intent.succeeded',{}));expect(await repository.findActive('merchant-a')).toMatchObject({setupIntentId:created.setupIntentId})})
  it('marks the replaced method detach_pending and lets reconciliation detach it',async()=>{const {repository,stripe,setup,complete}=create();const a=await setup.execute('merchant-a','a@test.fr');stripe.succeed(a.setupIntentId);await complete.execute('merchant-a',a.setupIntentId);const b=await setup.execute('merchant-a','a@test.fr');stripe.succeed(b.setupIntentId);await complete.execute('merchant-a',b.setupIntentId);expect([...repository.methods.values()].find(m=>m.setupIntentId===a.setupIntentId)?.status).toBe('detach_pending');expect(stripe.detachCalls).toEqual([]);repository.detachClaims.push({paymentMethodId:'pm_'+a.setupIntentId,token:'replace'});await new ReconcileDetachmentsUseCase(repository,stripe).run();expect(stripe.detachCalls).toEqual(['pm_'+a.setupIntentId])})
  it('handles setup failure, cancellation, inactive mandates, detached methods and duplicate events',async()=>{const {repository,stripe,setup,complete}=create();const pending=await setup.execute('merchant-a','a@test.fr');const webhook=new HandleStripeWebhookUseCase(repository,complete);await webhook.receive(stripeEvent('evt_failed','setup_intent.setup_failed',{id:pending.setupIntentId}));await webhook.processBatch();expect((await repository.findBySetupIntent(pending.setupIntentId))?.status).toBe('invalid');const live=await setup.execute('merchant-a','a@test.fr');stripe.succeed(live.setupIntentId);await complete.execute('merchant-a',live.setupIntentId);const active=await repository.findActive('merchant-a');await webhook.receive(stripeEvent('evt_mandate','mandate.updated',{id:active!.stripeMandateId,status:'inactive'}));await webhook.processBatch();expect((await repository.findActive('merchant-a'))).toBeNull();await webhook.receive(stripeEvent('evt_detached','payment_method.detached',{id:active!.stripePaymentMethodId}));await webhook.processBatch();expect(repository.events.size).toBe(3)})
  it('leaves a failed webhook replayable and makes duplicate durable receipts harmless',async()=>{const {repository,stripe,setup,complete}=create();const created=await setup.execute('merchant-a','a@test.fr');const webhook=new HandleStripeWebhookUseCase(repository,complete);const retry=stripeEvent('evt_retry','setup_intent.succeeded',{id:created.setupIntentId,metadata:{merchant_id:'merchant-a'}});await webhook.receive(retry);await webhook.processBatch();expect(repository.events.get('evt_retry')?.status).toBe('failed');stripe.succeed(created.setupIntentId);repository.events.get('evt_retry')!.status='pending';await Promise.all([webhook.receive(retry),webhook.receive(retry)]);await webhook.processBatch();expect(repository.events.get('evt_retry')?.status).toBe('processed');expect((await repository.findActive('merchant-a'))?.setupIntentId).toBe(created.setupIntentId)})

  it('receives only supported events, validates UUID syntax, and ignores missing object ids', async () => {
    const { repository, complete } = create(); const webhook = new HandleStripeWebhookUseCase(repository, complete)
    await webhook.receive(stripeEvent('evt_unknown', 'customer.created', { id: 'acct_test' }))
    await webhook.receive(stripeEvent('evt_missing', 'setup_intent.succeeded', {}))
    await webhook.receive(stripeEvent('evt_uuid', 'setup_intent.succeeded', { id: 'seti_test', metadata: { merchant_id: '22222222-2222-2222-2222-222222222222' } }))
    await webhook.receive(stripeEvent('evt_bad_uuid', 'setup_intent.succeeded', { id: 'seti_bad', metadata: { merchant_id: 'not-a-uuid' } }))
    expect(repository.events.size).toBe(2); expect(repository.events.get('evt_uuid')?.event.merchantId).toBe('22222222-2222-2222-2222-222222222222'); expect(repository.events.get('evt_bad_uuid')?.event.merchantId).toBeNull()
  })

  it('continues a batch after a poison event and stores only its error class with its claim token', async () => {
    const { repository, stripe, setup, complete } = create(); const created = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(created.setupIntentId)
    const webhook = new HandleStripeWebhookUseCase(repository, complete)
    await webhook.receive(stripeEvent('evt_poison', 'setup_intent.succeeded', { id: 'seti_unknown' }))
    await webhook.receive(stripeEvent('evt_healthy', 'setup_intent.succeeded', { id: created.setupIntentId }))
    await webhook.processBatch(2)
    expect(repository.events.get('evt_poison')).toMatchObject({ status: 'failed', errorClass: UnknownSetupIntentError.name })
    expect(repository.events.get('evt_healthy')?.status).toBe('processed'); expect(repository.failedWebhook[0]).toMatchObject({ eventId: 'evt_poison', token: expect.any(String), errorClass: UnknownSetupIntentError.name })
  })

  it('processes setup intent terminal states without unnecessary Stripe reads and supports both completion orders', async () => {
    const { repository, stripe, setup, complete } = create(); const created = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(created.setupIntentId)
    const webhook = new HandleStripeWebhookUseCase(repository, complete)
    await webhook.receive(stripeEvent('evt_before_complete', 'setup_intent.succeeded', { id: created.setupIntentId })); await webhook.processBatch()
    const reads = stripe.setupRetrievals; await webhook.receive(stripeEvent('evt_active', 'setup_intent.succeeded', { id: created.setupIntentId })); await webhook.processBatch()
    expect(stripe.setupRetrievals).toBe(reads)
    const second = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(second.setupIntentId); await complete.execute('merchant-a', second.setupIntentId)
    await webhook.receive(stripeEvent('evt_after_complete', 'setup_intent.succeeded', { id: second.setupIntentId })); await webhook.processBatch(); expect(repository.events.get('evt_after_complete')?.status).toBe('processed')
  })

  it('applies failed, canceled, detached, and inactive mandate webhook transitions', async () => {
    const { repository, stripe, setup, complete } = create(); const webhook = new HandleStripeWebhookUseCase(repository, complete)
    const pending = await setup.execute('merchant-a', 'a@test.fr'); await webhook.receive(stripeEvent('evt_cancel', 'setup_intent.canceled', { id: pending.setupIntentId })); await webhook.processBatch(); expect((await repository.findBySetupIntent(pending.setupIntentId))?.status).toBe('invalid')
    const active = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(active.setupIntentId); await complete.execute('merchant-a', active.setupIntentId); const current = await repository.findActive('merchant-a')
    await webhook.receive(stripeEvent('evt_mandate_active', 'mandate.updated', { id: current!.stripeMandateId, status: 'active' })); await webhook.processBatch(); expect((await repository.findActive('merchant-a'))).not.toBeNull()
    await webhook.receive(stripeEvent('evt_mandate_inactive', 'mandate.updated', { id: current!.stripeMandateId, status: 'inactive' })); await webhook.processBatch(); expect((await repository.findBySetupIntent(active.setupIntentId))?.status).toBe('invalid')
    const replacement = await setup.execute('merchant-a', 'a@test.fr'); stripe.succeed(replacement.setupIntentId); await complete.execute('merchant-a', replacement.setupIntentId); const live = await repository.findActive('merchant-a')
    await webhook.receive(stripeEvent('evt_detached', 'payment_method.detached', { id: live!.stripePaymentMethodId })); await webhook.processBatch(); expect((await repository.findBySetupIntent(replacement.setupIntentId))?.status).toBe('invalid')
  })

  it('reconciles detachments independently, including missing Stripe resources and failures', async () => {
    const repository = new MemoryRepository(); const stripe = new FakeStripe(); repository.detachClaims.push({ paymentMethodId: 'pm_ok', token: 'token_ok' }, { paymentMethodId: 'pm_missing', token: 'token_missing' }, { paymentMethodId: 'pm_failure', token: 'token_failure' })
    const original = stripe.detachPaymentMethod.bind(stripe); stripe.detachPaymentMethod = async (id) => { if (id === 'pm_missing') throw new StripeResourceMissingError(); if (id === 'pm_failure') throw new Error('not retained'); await original(id) }
    await new ReconcileDetachmentsUseCase(repository, stripe).run()
    expect(repository.detached).toEqual(expect.arrayContaining(['pm_ok', 'pm_missing'])); expect(repository.detachFailures).toEqual([{ paymentMethodId: 'pm_failure', token: 'token_failure', errorClass: 'Error' }])
  })

  it('runs reconciliation after a webhook worker failure, serializes cycles, and stops cleanly', async () => {
    vi.useFakeTimers(); let webhooks = 0; let reconciliations = 0; let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => { release = resolve }); const stop = startStripePaymentsWorker({ processWebhooks: async () => { webhooks++; if (webhooks === 1) throw new Error('failure'); if (webhooks === 2) await wait }, reconcileDetachments: async () => { reconciliations++ } }, undefined, 100)
    await vi.advanceTimersByTimeAsync(100); expect(reconciliations).toBe(1); await vi.advanceTimersByTimeAsync(300); expect(webhooks).toBe(2); release!(); await vi.advanceTimersByTimeAsync(1); stop(); const before = webhooks; await vi.advanceTimersByTimeAsync(500); expect(webhooks).toBe(before); vi.useRealTimers()
  })
})
