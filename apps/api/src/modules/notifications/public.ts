import { SendNewOrderPushesUseCase, type DriverPushTokenReader, type NewOrderPushCommand } from './application/send-new-order-pushes.js'
import { SendDispatchOfferPushUseCase, type DispatchOfferPushCommand } from './application/send-dispatch-offer-push.js'
import { ExpoPushProvider } from './infrastructure/expo-push-provider.js'
import type { PushProvider } from './ports/push-provider.js'

export type { PushMessage, PushProvider } from './ports/push-provider.js'
export type { DriverPushTokenReader, NewOrderPushCommand } from './application/send-new-order-pushes.js'
export type { DispatchOfferPushCommand } from './application/send-dispatch-offer-push.js'

export type NotificationsModule = {
  sendNewOrderPushes(command: NewOrderPushCommand): Promise<void>
  sendDispatchOfferPush(command: DispatchOfferPushCommand): Promise<void>
}

export function createNotificationsModule(
  tokenReader: DriverPushTokenReader,
  pushProvider: PushProvider = new ExpoPushProvider()
): NotificationsModule {
  const sendNewOrderPushesUseCase = new SendNewOrderPushesUseCase(tokenReader, pushProvider)
  const sendDispatchOfferPushUseCase = new SendDispatchOfferPushUseCase(tokenReader, pushProvider)
  return {
    sendNewOrderPushes: sendNewOrderPushesUseCase.execute.bind(sendNewOrderPushesUseCase),
    sendDispatchOfferPush: sendDispatchOfferPushUseCase.execute.bind(sendDispatchOfferPushUseCase)
  }
}
