import { describe, expect, it } from 'vitest'
import {
  DeliveryCodeExpiredError,
  DeliveryCodeInvalidError,
  DeliveryCodeLockedError,
  generateDeliveryCode,
  verifyDeliveryCode
} from '../../src/modules/orders/domain/delivery-code.js'

describe('delivery code', () => {
  it('generates a four-digit code, hashes it and verifies it without comparing plaintext', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z')
    const code = await generateDeliveryCode(now)

    expect(code.plain).toMatch(/^\d{4}$/)
    expect(code.hash).not.toBe(code.plain)
    expect(code.expiresAt).toEqual(new Date('2026-09-12T14:00:00.000Z'))
    await expect(verifyDeliveryCode(code.plain, code.hash)).resolves.toBe(true)
    await expect(verifyDeliveryCode('0000', code.hash)).resolves.toBe(false)
  })

  it('carries the API-facing failure data for expiration, invalid attempts and lockout', () => {
    expect(new DeliveryCodeExpiredError()).toBeInstanceOf(Error)
    expect(new DeliveryCodeInvalidError(2).attemptsRemaining).toBe(2)
    expect(new DeliveryCodeLockedError()).toBeInstanceOf(Error)
  })
})
