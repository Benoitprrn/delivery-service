import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import rawBody from 'fastify-raw-body'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerCorrelationId } from '../../src/platform/correlation-id.js'
import { registerAuthentication } from '../../src/modules/auth/transport/http/authentication-hook.js'
import { registerPaymentHttpRoutes } from '../../src/modules/payments/transport/http/routes.js'
import type { MerchantPaymentMethod } from '../../src/modules/payments/ports/payment-repository.js'
import { LegalInformationRequiredError, PaymentConfigurationError, PaymentMethodNotReadyError, SetupAlreadyCompletedError, SetupProcessingError, SetupStatusUnsupportedError, StripeSetupFailedError, StripeWebhookSignatureError } from '../../src/modules/payments/application/sepa-payment-method.js'
import { StripeIdempotencyConflictError, StripeProviderError, StripeUnavailableError } from '../../src/modules/payments/ports/stripe-provider.js'

const secret = 'webhook-test-secret'
const methodA = { id:'local-a',merchantId:'merchant-a',setupIntentId:'seti_a',stripePaymentMethodId:'pm_a',stripeMandateId:'mandate_a',status:'active' as const,bankName:'Banque A',last4:'1111',country:'FR',mandateReference:'ref-a',activatedAt:new Date(),invalidatedAt:null }
const methodB = { ...methodA, id:'local-b',merchantId:'merchant-b',setupIntentId:'seti_b',stripePaymentMethodId:'pm_b',stripeMandateId:'mandate_b',bankName:'Banque B',last4:'2222' }
let paymentError: Error | null = null
let getPaymentMethodError: Error | null = null

function signature(payload: string): string { return `v1=${createHmac('sha256',secret).update(payload).digest('hex')}` }
function safeEqual(left: string, right: string): boolean { const a=Buffer.from(left);const b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b) }

type PaymentHttpHandlers = { getPaymentMethod: (merchantId:string)=>Promise<MerchantPaymentMethod|null>; createSetupIntent: (merchantId:string,email:string|undefined)=>Promise<{clientSecret:string}>; completeSetupIntent: (merchantId:string,setupIntentId:string)=>Promise<MerchantPaymentMethod>; receiveWebhook: (payload:string|Buffer,signature:string)=>Promise<void> }
function fakePayments(): { payments: PaymentHttpHandlers; webhooks: string[] } {
  const webhooks: string[]=[]
  return {
    webhooks,
    payments: {
      getPaymentMethod: async (merchantId) => { if (getPaymentMethodError !== null) throw getPaymentMethodError; return merchantId==='merchant-a'?methodA:merchantId==='merchant-b'?methodB:null },
      createSetupIntent: async (merchantId) => { if (paymentError !== null) throw paymentError; return { setupIntentId:`seti_${merchantId}`,clientSecret:`seti_${merchantId}_secret_only_here` } },
      completeSetupIntent: async (merchantId, setupIntentId) => { if(setupIntentId==='seti_b'&&merchantId==='merchant-a')throw new PaymentMethodNotReadyError('Unknown SetupIntent'); return merchantId==='merchant-a'?methodA:methodB },
      receiveWebhook: async (payload, receivedSignature) => { const raw=typeof payload==='string'?payload:payload.toString('utf8'); if(!safeEqual(receivedSignature,signature(raw)))throw new StripeWebhookSignatureError('signature'); webhooks.push(raw); }
    }
  }
}

describe('payments HTTP endpoints', () => {
  let app: FastifyInstance
  let webhooks: string[]

  beforeEach(async () => {
    paymentError = null
    getPaymentMethodError = null
    const fake=fakePayments();webhooks=fake.webhooks
    app=Fastify({logger:false})
    registerCorrelationId(app)
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
    registerAuthentication(app,{verifier:{verify:async(token)=>{
      if(token==='merchant-a')return{id:'merchant-a',role:'merchant',email:'a@example.test'}
      if(token==='merchant-b')return{id:'merchant-b',role:'merchant',email:'b@example.test'}
      return{id:'driver',role:'driver'}
    }}})
    await app.register(rawBody,{field:'rawBody',global:false,encoding:'utf8',runFirst:true})
    await app.register(registerPaymentHttpRoutes,{payments:fake.payments})
    app.get('/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
  })

  afterEach(async () => { await app.close() })

  it('requires authentication and keeps merchant payment methods isolated', async () => {
    expect((await app.inject({method:'GET',url:'/api/v1/merchants/me/payment-method'})).statusCode).toBe(401)
    const a=await app.inject({method:'GET',url:'/api/v1/merchants/me/payment-method',headers:{authorization:'Bearer merchant-a'}})
    const b=await app.inject({method:'GET',url:'/api/v1/merchants/me/payment-method',headers:{authorization:'Bearer merchant-b'}})
    expect(a.json()).toEqual({paymentMethod:{status:'active',bankName:'Banque A',last4:'1111',country:'FR'}})
    expect(b.json()).toEqual({paymentMethod:{status:'active',bankName:'Banque B',last4:'2222',country:'FR'}})
    expect(a.body).not.toContain('seti_');expect(a.body).not.toContain('pm_');expect(a.body).not.toContain('mandate_')
  })

  it('does not expose internal errors from the payment-method read', async () => {
    getPaymentMethodError = new Error('secret database detail')
    const response = await app.inject({ method: 'GET', url: '/api/v1/merchants/me/payment-method', headers: { authorization: 'Bearer merchant-a' } })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ error: 'InternalError', correlationId: expect.any(String) })
    expect(response.body).not.toContain('message')
    expect(response.body).not.toContain('secret database detail')
  })

  it('exposes only the client secret when it creates a SetupIntent and validates its empty payload', async () => {
    const created=await app.inject({method:'POST',url:'/api/v1/merchants/me/payment-method/setup-intents',headers:{authorization:'Bearer merchant-a'}})
    expect(created.statusCode).toBe(200);expect(created.json()).toEqual({clientSecret:'seti_merchant-a_secret_only_here'});expect(created.body).not.toContain('setupIntentId')
    const invalid=await app.inject({method:'POST',url:'/api/v1/merchants/me/payment-method/setup-intents',headers:{authorization:'Bearer merchant-a'},payload:{unexpected:true}})
    expect(invalid.statusCode).toBe(400)
  })

  it.each([
    [new PaymentMethodNotReadyError('private'), 409, 'PaymentMethodNotReady'],
    [new SetupProcessingError(), 409, 'SetupProcessing'],
    [new SetupAlreadyCompletedError(), 409, 'SetupAlreadyCompleted'],
    [new SetupStatusUnsupportedError(), 409, 'SetupStatusUnsupported'],
    [new StripeSetupFailedError('private'), 422, 'SetupNotCompleted'],
    [new LegalInformationRequiredError('private'), 422, 'LegalInformationRequired'],
    [new PaymentConfigurationError('private'), 422, 'AccountEmailUnavailable'],
    [new StripeIdempotencyConflictError(), 409, 'CustomerCreationInProgress'],
    [new StripeUnavailableError('private'), 503, 'StripeUnavailable'],
    [new StripeProviderError(new Error('stripe private')), 502, 'StripeProviderError'],
    [new Error('internal secret'), 500, 'InternalError']
  ])('maps %s to its stable public error code', async (thrown, status, code) => {
    paymentError = thrown
    const response = await app.inject({ method: 'POST', url: '/api/v1/merchants/me/payment-method/setup-intents', headers: { authorization: 'Bearer merchant-a' } })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toEqual({ error: code, correlationId: expect.any(String) })
    expect(response.body).not.toContain('message')
    expect(response.body).not.toContain('secret')
  })

  it('maps invalid input without exposing an error message', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/merchants/me/payment-method/setup-intents', headers: { authorization: 'Bearer merchant-a' }, payload: { unexpected: true } })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'InvalidRequest', correlationId: expect.any(String) })
    expect(response.body).not.toContain('message')
  })

  it('validates completion, blocks cross-merchant SetupIntents, and returns only the display summary', async () => {
    const invalid=await app.inject({method:'POST',url:'/api/v1/merchants/me/payment-method/setup-intents/complete',headers:{authorization:'Bearer merchant-a'},payload:{setupIntentId:1}})
    expect(invalid.statusCode).toBe(400)
    const forbidden=await app.inject({method:'POST',url:'/api/v1/merchants/me/payment-method/setup-intents/complete',headers:{authorization:'Bearer merchant-a'},payload:{setupIntentId:'seti_b'}})
    expect(forbidden.statusCode).toBe(409)
    const complete=await app.inject({method:'POST',url:'/api/v1/merchants/me/payment-method/setup-intents/complete',headers:{authorization:'Bearer merchant-a'},payload:{setupIntentId:'seti_a'}})
    expect(complete.json()).toEqual({paymentMethod:{status:'active',bankName:'Banque A',last4:'1111',country:'FR'}})
    expect(complete.body).not.toContain('seti_');expect(complete.body).not.toContain('pm_');expect(complete.body).not.toContain('mandate_')
  })

  it('requires a valid signature over the raw body and is public only for Stripe delivery', async () => {
    const payload='{"id":"evt_raw","type":"unknown.event","data":{"object":{"unchanged":true}}}'
    expect((await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload,headers:{'content-type':'application/json'}})).statusCode).toBe(400)
    expect((await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload,headers:{'content-type':'application/json','stripe-signature':'v1=invalid'}})).statusCode).toBe(400)
    const valid=await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload,headers:{'content-type':'application/json','stripe-signature':signature(payload)}})
    expect(valid.statusCode).toBe(200);expect(webhooks).toEqual([payload])
  })

  it('acknowledges unknown, duplicate, and deferred events after durable receipt', async () => {
    const unknown='{"id":"evt_duplicate","type":"unknown.event"}'
    expect((await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload:unknown,headers:{'content-type':'application/json','stripe-signature':signature(unknown)}})).statusCode).toBe(200)
    expect((await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload:unknown,headers:{'content-type':'application/json','stripe-signature':signature(unknown)}})).statusCode).toBe(200)
    const failed='{"id":"evt_retry","type":"transient.failure"}'
    expect((await app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload:failed,headers:{'content-type':'application/json','stripe-signature':signature(failed)}})).statusCode).toBe(200)
  })

  it('exempts signed Stripe webhooks from the global rate limit while ordinary routes remain limited', async () => {
    const payload='{"id":"evt_rate_limit","type":"unknown.event","data":{"object":{"id":"obj_rate_limit"}}}'
    const overGlobalLimit=110 // le plafond global est de 100/min : sans exemption, les dernières requêtes seraient refusées en 429
    const replies=await Promise.all(Array.from({length:overGlobalLimit},()=>app.inject({method:'POST',url:'/api/v1/webhooks/stripe',payload,headers:{'content-type':'application/json','stripe-signature':signature(payload)}})))
    expect(replies.every(reply=>reply.statusCode===200)).toBe(true)
    await app.inject({method:'GET',url:'/limited'});await app.inject({method:'GET',url:'/limited'})
    expect((await app.inject({method:'GET',url:'/limited'})).statusCode).toBe(429)
  })
})
