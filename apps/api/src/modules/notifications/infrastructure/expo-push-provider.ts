import type { PushMessage, PushProvider } from '../ports/push-provider.js'
import { logger } from '../../../platform/logger.js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

export class ExpoPushProvider implements PushProvider {
  public async sendPush(message: PushMessage): Promise<void> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{
          to: message.token,
          title: message.title,
          body: message.body,
          channelId: 'new-orders',
          data: message.data
        }])
      })
      const payload: unknown = await response.json()
      if (!response.ok) {
        logger.error(
          { orderId: message.data.orderId, statusCode: response.status, expoResponse: payload },
          'Expo Push API request failed'
        )
        throw new Error(`Expo Push API responded with ${response.status}`)
      }

      const tickets = typeof payload === 'object' && payload !== null && 'data' in payload && Array.isArray(payload.data)
        ? payload.data
        : []
      logger.info({ orderId: message.data.orderId, tickets }, 'Expo Push API returned tickets')

      const failedTicket = tickets.find((ticket) =>
        typeof ticket === 'object' && ticket !== null && 'status' in ticket && ticket.status === 'error'
      )
      if (failedTicket !== undefined) {
        const errorMessage = 'message' in failedTicket && typeof failedTicket.message === 'string'
          ? failedTicket.message
          : 'Expo Push API rejected notification'
        logger.error({ orderId: message.data.orderId, ticket: failedTicket }, 'Expo Push API rejected notification')
        throw new Error(errorMessage)
      }
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Expo Push API'))) {
        logger.error({ err: error, orderId: message.data.orderId }, 'Expo Push API request failed unexpectedly')
      }
      throw error
    }
  }
}
