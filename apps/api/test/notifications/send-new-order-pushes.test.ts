import { describe, expect, it, vi } from 'vitest'
import { SendNewOrderPushesUseCase } from '../../src/modules/notifications/application/send-new-order-pushes.js'

describe('SendNewOrderPushesUseCase', () => {
  it('sends the new-order notification only to registered eligible driver tokens', async () => {
    const findPushTokensByDriverIds = vi.fn().mockResolvedValue(['ExponentPushToken[first]', 'ExponentPushToken[second]'])
    const sendPush = vi.fn().mockResolvedValue(undefined)
    const useCase = new SendNewOrderPushesUseCase({ findPushTokensByDriverIds }, { sendPush })

    await useCase.execute({
      driverIds: ['driver-1', 'driver-2'],
      orderId: 'order-1',
      distanceM: 1_250,
      durationS: 720,
      priceCents: 850
    })

    expect(findPushTokensByDriverIds).toHaveBeenCalledWith(['driver-1', 'driver-2'])
    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(sendPush).toHaveBeenCalledWith({
      token: 'ExponentPushToken[first]',
      title: 'Nouvelle course 🛵',
      body: '1,3 km · 12 min · 8,50 €',
      data: { orderId: 'order-1' }
    })
  })

  it('does not call the provider when no eligible driver has registered a token', async () => {
    const sendPush = vi.fn()
    const useCase = new SendNewOrderPushesUseCase({ findPushTokensByDriverIds: async () => [] }, { sendPush })

    await useCase.execute({ driverIds: [], orderId: 'order-1', distanceM: 0, durationS: 0, priceCents: 400 })

    expect(sendPush).not.toHaveBeenCalled()
  })
})
