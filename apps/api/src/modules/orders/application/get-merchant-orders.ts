import type { MerchantOrder } from '../domain/order.js'
import type { OrderRepository } from '../ports/order-repository.js'

export class GetMerchantOrdersUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public async execute(merchantId: string): Promise<MerchantOrder[]> {
    return this.orderRepository.findByMerchantId(merchantId)
  }
}
