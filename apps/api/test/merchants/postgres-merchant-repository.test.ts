import { describe, expect, it } from 'vitest'
import { createMerchantsModule } from '../../src/modules/merchants/public.js'
import { pool } from '../../src/platform/db.js'

const merchantId = '22222222-2222-2222-2222-222222222222'

describe('PostgresMerchantRepository', () => {
  it('returns Postgres double precision values as numbers', async () => {
    const { findMerchantById } = createMerchantsModule(pool)
    const merchant = await findMerchantById(merchantId)

    expect(merchant).not.toBeNull()
    expect(typeof merchant?.lat).toBe('number')
    expect(typeof merchant?.lng).toBe('number')
  })
})
