import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/platform/config.js'
import { createStripeProvider } from '../../src/modules/payments/public.js'

const base = {
  NODE_ENV:'production', DATABASE_URL:'postgres://db', PGBOSS_DATABASE_URL:'postgres://boss', OSRM_URL:'http://osrm', VROOM_URL:'http://vroom', OPENCAGE_API_KEY:'key', SUPABASE_URL:'http://supabase', SUPABASE_SECRET_KEY:'secret', DRIVER_SIGNUP_ZONE_ID:'11111111-1111-1111-1111-111111111111', VALKEY_URL:'redis://valkey'
}

describe('Stripe production configuration', () => {
  it('allows Stripe to be explicitly disabled without credentials', () => {
    expect(loadConfig({...base,STRIPE_PAYMENTS_ENABLED:'false'}).STRIPE_SECRET_KEY).toBeUndefined()
  })
  it('rejects incomplete and enabled-without-keys configurations', () => {
    expect(()=>loadConfig({...base,STRIPE_PAYMENTS_ENABLED:'true',STRIPE_SECRET_KEY:'sk'})).toThrow('Stripe payments are enabled but Stripe credentials are missing')
    expect(loadConfig({...base,STRIPE_PAYMENTS_ENABLED:'false',STRIPE_SECRET_KEY:'sk',STRIPE_WEBHOOK_SECRET:'whsec'}).STRIPE_PAYMENTS_ENABLED).toBe(false)
    expect(()=>loadConfig({...base,STRIPE_PAYMENTS_ENABLED:'true'})).toThrow('enabled but Stripe credentials are missing')
  })
  it('does not instantiate an enabled Stripe provider when the flag is false', async () => {
    const provider=createStripeProvider(false,'not-a-real-key','not-a-real-secret')
    await expect(provider.createCustomerAccount({merchantId:'merchant-a'})).rejects.toThrow('Stripe is not configured')
  })
  it('treats blank Stripe values as absent', () => {
    expect(()=>loadConfig({...base,STRIPE_PAYMENTS_ENABLED:'true',STRIPE_SECRET_KEY:' ',STRIPE_WEBHOOK_SECRET:''})).toThrow('enabled but Stripe credentials are missing')
  })
  it('imposes no Accounts v2 version when absent or blank and preserves an explicit override', () => {
    expect(loadConfig({...base}).STRIPE_ACCOUNTS_V2_API_VERSION).toBeUndefined()
    expect(loadConfig({...base, STRIPE_ACCOUNTS_V2_API_VERSION: ' '}).STRIPE_ACCOUNTS_V2_API_VERSION).toBeUndefined()
    expect(loadConfig({...base, STRIPE_ACCOUNTS_V2_API_VERSION: '2026-09-01.preview'}).STRIPE_ACCOUNTS_V2_API_VERSION).toBe('2026-09-01.preview')
  })
})
