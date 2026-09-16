import type { DispatchOffer } from '../domain/dispatch-offer.js'
import { DispatchOfferAccessDeniedError, DispatchOfferNotFoundError } from '../domain/errors.js'
import type { DispatchRepository } from '../ports/dispatch-repository.js'
import type { DriverOrder } from '../../orders/domain/order.js'

type OrdersFacade = {
  findDriverOrderById(orderId: string): Promise<DriverOrder | null>
}

export class GetDispatchOfferUseCase {
  public constructor(private readonly repository: DispatchRepository, private readonly orders: OrdersFacade) {}

  public async execute(offerId: string, driverId: string): Promise<{ offer: DispatchOffer; order: DriverOrder }> {
    const offer = await this.repository.findById(offerId)
    if (offer === null) throw new DispatchOfferNotFoundError(`Dispatch offer ${offerId} not found`)
    if (offer.driverId !== driverId) {
      throw new DispatchOfferAccessDeniedError(`Dispatch offer ${offerId} does not belong to driver ${driverId}`)
    }
    const order = await this.orders.findDriverOrderById(offer.orderId)
    if (order === null) throw new DispatchOfferNotFoundError(`Order ${offer.orderId} associated with dispatch offer ${offerId} not found`)
    return { offer, order }
  }
}
