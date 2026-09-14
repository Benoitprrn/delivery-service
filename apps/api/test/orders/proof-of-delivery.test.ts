import { describe, expect, it } from 'vitest'
import { decodeProofOfDelivery, InvalidProofOfDeliveryError } from '../../src/modules/orders/domain/proof-of-delivery.js'

describe('proof of delivery validation', () => {
  it('accepts a PNG signature within the 256KB limit', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(decodeProofOfDelivery('signature', signature.toString('base64'))).toMatchObject({
      method: 'signature', contentType: 'image/png'
    })
  })

  it('accepts a JPEG photo within the 500KB limit', () => {
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    expect(decodeProofOfDelivery('photo', photo.toString('base64'))).toMatchObject({
      method: 'photo', contentType: 'image/jpeg'
    })
  })

  it('rejects wrong binary types and oversized assets', () => {
    expect(() => decodeProofOfDelivery('signature', '/9j/2Q==')).toThrow(InvalidProofOfDeliveryError)
    const oversizedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256 * 1024)
    ])
    expect(() => decodeProofOfDelivery('signature', oversizedPng.toString('base64'))).toThrow(
      InvalidProofOfDeliveryError
    )
  })
})
