import type { OrderRepository, VerifyDeliveryCodeForCompletionInput } from '../ports/order-repository.js'

export type VerifyDeliveryCodeForCompletionCommand = VerifyDeliveryCodeForCompletionInput

export class VerifyDeliveryCodeForCompletionUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: VerifyDeliveryCodeForCompletionCommand): Promise<{ verified: true }> {
    return this.orderRepository.verifyDeliveryCodeForCompletion(command)
  }
}
