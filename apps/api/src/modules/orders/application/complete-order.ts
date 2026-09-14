import { randomUUID } from 'node:crypto'
import type { Actor, Order } from '../domain/order.js'
import { decodeProofOfDelivery, type ProofOfDeliveryAsset } from '../domain/proof-of-delivery.js'
import type { OrderRepository } from '../ports/order-repository.js'

export type CompleteOrderCommand = {
  orderId: string
  driverId: string
  expectedVersion: number
  proof:
    | { method: 'code'; code: string }
    | { method: 'signature'; imageBase64: string }
    | { method: 'photo'; imageBase64: string }
  actor: Actor
  correlationId?: string
}

export class CompleteOrderUseCase {
  public constructor(private readonly orderRepository: OrderRepository) {}

  public execute(command: CompleteOrderCommand): Promise<Order> {
    const proof = this.toRepositoryProof(command.proof)
    return this.orderRepository.complete(
      command.orderId,
      command.driverId,
      command.expectedVersion,
      proof,
      command.actor,
      command.correlationId ?? randomUUID()
    )
  }

  private toRepositoryProof(proof: CompleteOrderCommand['proof']): { method: 'code'; code: string } | ProofOfDeliveryAsset {
    if (proof.method === 'code') {
      return proof
    }
    return decodeProofOfDelivery(proof.method, proof.imageBase64)
  }
}
