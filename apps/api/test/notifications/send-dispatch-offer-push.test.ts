import { describe, expect, it, vi } from 'vitest'
import { SendDispatchOfferPushUseCase } from '../../src/modules/notifications/application/send-dispatch-offer-push.js'

describe('SendDispatchOfferPushUseCase', () => {
  it('sends a dispatch offer only to its selected driver', async () => {
    const findPushTokensByDriverIds = vi.fn().mockResolvedValue(['ExponentPushToken[driver-1]'])
    const sendPush = vi.fn().mockResolvedValue(undefined)
    const useCase = new SendDispatchOfferPushUseCase({ findPushTokensByDriverIds }, { sendPush })

    await useCase.execute({ driverId: 'driver-1', offerId: 'offer-1', orderId: 'order-1' })

    expect(findPushTokensByDriverIds).toHaveBeenCalledWith(['driver-1'])
    expect(sendPush).toHaveBeenCalledWith({
      token: 'ExponentPushToken[driver-1]',
      title: 'Nouvelle course 🛵',
      body: 'Une nouvelle course vous attend.',
      data: { orderId: 'order-1', offerId: 'offer-1' }
    })
  })
})
