import type { PushProvider } from '../ports/push-provider.js'
import { logger } from '../../../platform/logger.js'

export type DispatchOfferPushCommand = {
  driverId: string
  offerId: string
  orderId: string
}

export type DriverPushTokenReader = {
  findPushTokensByDriverIds(driverIds: readonly string[]): Promise<string[]>
}

/** Sends a dispatch offer to its sole candidate (sequential dispatch). */
export class SendDispatchOfferPushUseCase {
  public constructor(
    private readonly tokenReader: DriverPushTokenReader,
    private readonly pushProvider: PushProvider
  ) {}

  public async execute(command: DispatchOfferPushCommand): Promise<void> {
    const tokens = await this.tokenReader.findPushTokensByDriverIds([command.driverId])
    logger.info({ orderId: command.orderId, driverId: command.driverId, pushTokensCount: tokens.length }, 'Resolved push tokens for dispatch offer')
    await Promise.all(tokens.map(async (token) => this.pushProvider.sendPush({
      token,
      title: 'Nouvelle course 🛵',
      body: 'Une nouvelle course vous attend.',
      data: { orderId: command.orderId, offerId: command.offerId }
    })))
  }
}
