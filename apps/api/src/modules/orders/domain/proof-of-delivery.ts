export type ProofOfDeliveryAsset = {
  method: 'signature' | 'photo'
  content: Uint8Array
  contentType: 'image/png' | 'image/jpeg'
}

export class InvalidProofOfDeliveryError extends Error {
  public constructor(message = 'Proof of delivery is invalid') {
    super(message)
    this.name = 'InvalidProofOfDeliveryError'
  }
}

export function decodeProofOfDelivery(kind: 'signature' | 'photo', imageBase64: string): ProofOfDeliveryAsset {
  const content = Buffer.from(imageBase64, 'base64')
  const isPng = content.length >= 8 &&
    content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47 &&
    content[4] === 0x0d && content[5] === 0x0a && content[6] === 0x1a && content[7] === 0x0a
  const isJpeg = content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 &&
    content[2] === 0xff && content[content.length - 2] === 0xff && content[content.length - 1] === 0xd9

  if (kind === 'signature' && isPng && content.length <= 256 * 1024) {
    return { method: kind, content, contentType: 'image/png' }
  }
  if (kind === 'photo' && isJpeg && content.length <= 500 * 1024) {
    return { method: kind, content, contentType: 'image/jpeg' }
  }
  throw new InvalidProofOfDeliveryError(
    kind === 'signature' ? 'Signature must be a PNG smaller than 256KB' : 'Proof photo must be a JPEG smaller than 500KB'
  )
}
