import type { PushProvider } from '../ports/push-provider.js'
import { logger } from '../../../platform/logger.js'

export type NewOrderPushCommand = {
  driverIds: readonly string[]
  orderId: string
  distanceM: number
  durationS: number
  priceCents: number
}

export type DriverPushTokenReader = {
  findPushTokensByDriverIds(driverIds: readonly string[]): Promise<string[]>
}

function formatPushBody(distanceM: number, durationS: number, priceCents: number): string {
  const distanceKm = (distanceM / 1_000).toFixed(1).replace('.', ',')
  const durationMin = Math.round(durationS / 60)
  const euros = Math.trunc(priceCents / 100)
  const cents = Math.abs(priceCents % 100).toString().padStart(2, '0')
  return `${distanceKm} km · ${durationMin} min · ${euros},${cents} €`
}

export class SendNewOrderPushesUseCase {
  public constructor(
    private readonly tokenReader: DriverPushTokenReader,
    private readonly pushProvider: PushProvider
  ) {}

  public async execute(command: NewOrderPushCommand): Promise<void> {
    logger.info(
      {
        orderId: command.orderId,
        eligibleDriverIds: command.driverIds,
        eligibleDriverIdsCount: command.driverIds.length
      },
      'Resolving push tokens for eligible drivers'
    )
    const tokens = await this.tokenReader.findPushTokensByDriverIds(command.driverIds)
    logger.info(
      { orderId: command.orderId, pushTokensCount: tokens.length },
      'Resolved push tokens for new order'
    )
    const body = formatPushBody(command.distanceM, command.durationS, command.priceCents)
    await Promise.all(tokens.map((token) => this.pushProvider.sendPush({
      token,
      title: 'Nouvelle course 🛵',
      body,
      data: { orderId: command.orderId }
    })))
  }
}
