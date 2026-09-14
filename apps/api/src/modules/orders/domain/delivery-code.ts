import { randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 12

export type DeliveryCode = {
  plain: string
  hash: string
  generatedAt: Date
  expiresAt: Date
}

export async function generateDeliveryCode(now = new Date()): Promise<DeliveryCode> {
  const plain = String(randomInt(1000, 10_000))
  return {
    plain,
    hash: await bcrypt.hash(plain, BCRYPT_ROUNDS),
    generatedAt: now,
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1_000)
  }
}

export function verifyDeliveryCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash)
}

export class DeliveryCodeExpiredError extends Error {
  public constructor(message = 'Delivery code has expired or was not generated') {
    super(message)
    this.name = 'DeliveryCodeExpiredError'
  }
}

export class DeliveryCodeInvalidError extends Error {
  public constructor(public readonly attemptsRemaining: number) {
    super('Delivery code is invalid')
    this.name = 'DeliveryCodeInvalidError'
  }
}

export class DeliveryCodeLockedError extends Error {
  public constructor(message = 'Delivery code is locked after too many failed attempts') {
    super(message)
    this.name = 'DeliveryCodeLockedError'
  }
}
