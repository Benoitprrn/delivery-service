import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/platform/config.js'
import { createStripeConnectWebhookModule, parseConnectWebhookSecrets } from '../../src/modules/payments/connect-webhooks.js'
import { pool } from '../../src/platform/db.js'

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://db',
  PGBOSS_DATABASE_URL: 'postgres://boss',
  OSRM_URL: 'http://osrm',
  VROOM_URL: 'http://vroom',
  OPENCAGE_API_KEY: 'key',
  SUPABASE_URL: 'http://supabase',
  SUPABASE_SECRET_KEY: 'secret',
  DRIVER_SIGNUP_ZONE_ID: '11111111-1111-1111-1111-111111111111',
  VALKEY_URL: 'redis://valkey'
}

const domain = {
  findPaymentAccountId: async () => null,
  reconcilePaymentIntent: async () => undefined,
  refreshMerchantAccountStatus: async () => undefined,
  refreshDriverAccountStatus: async () => undefined,
  findDriverIdByAccountId: async () => null
}

describe('STRIPE_CONNECT_WEBHOOK_SECRET configuration', () => {
  it('is optional: absent or blank counts as missing and never blocks startup', () => {
    expect(loadConfig({ ...base }).STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined()
    expect(loadConfig({ ...base, STRIPE_CONNECT_WEBHOOK_SECRET: '' }).STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined()
    expect(loadConfig({ ...base, STRIPE_CONNECT_WEBHOOK_SECRET: '   ' }).STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined()
  })

  it('keeps a configured value', () => {
    expect(loadConfig({ ...base, STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' }).STRIPE_CONNECT_WEBHOOK_SECRET).toBe('whsec_connect')
  })

  it('is not required when Stripe payments are enabled with only the two existing secrets', () => {
    const config = loadConfig({
      ...base,
      STRIPE_PAYMENTS_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x'
    })
    expect(config.STRIPE_PAYMENTS_ENABLED).toBe(true)
    expect(config.STRIPE_CONNECT_WEBHOOK_SECRET).toBeUndefined()
  })

  it('does not replace the existing requirements: enabled Stripe still needs its own secrets', () => {
    expect(() => loadConfig({
      ...base,
      STRIPE_PAYMENTS_ENABLED: 'true',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect'
    })).toThrow('Stripe payments are enabled but Stripe credentials are missing')
  })

  it('splits one secret per Stripe event destination', () => {
    expect(parseConnectWebhookSecrets('whsec_a, whsec_b ,')).toEqual(['whsec_a', 'whsec_b'])
    expect(parseConnectWebhookSecrets(undefined)).toEqual([])
  })
})

describe('Stripe Connect webhook module activation', () => {
  const stripeEnabledOptions = { paymentsEnabled: true, secretKey: 'sk_test_local', webhookSecret: 'whsec_connect', domain }

  it('is enabled only when Stripe payments are on AND the Connect secret is present', () => {
    expect(createStripeConnectWebhookModule(pool, stripeEnabledOptions).enabled).toBe(true)
    expect(createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, webhookSecret: undefined }).enabled).toBe(false)
    expect(createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, webhookSecret: ' , ' }).enabled).toBe(false)
    expect(createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, paymentsEnabled: false }).enabled).toBe(false)
    expect(createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, secretKey: undefined }).enabled).toBe(false)
  })

  it('answers as unavailable, never as an invalid signature, when disabled', async () => {
    const disabled = createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, paymentsEnabled: false })
    await expect(disabled.receiveWebhook('{}', 't=1,v1=abc')).rejects.toThrow('Stripe Connect webhook is not configured')
    const noSecret = createStripeConnectWebhookModule(pool, { ...stripeEnabledOptions, webhookSecret: undefined })
    await expect(noSecret.receiveWebhook('{}', 't=1,v1=abc')).rejects.toThrow('Stripe Connect webhook is not configured')
  })
})
