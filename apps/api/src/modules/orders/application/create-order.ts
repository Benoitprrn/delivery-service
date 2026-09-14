import { randomUUID } from 'node:crypto'
import type { Merchant } from '../../merchants/public.js'
import type { Zone } from '../../zones/public.js'
import { DeliveryOutsideZoneError } from '../domain/errors.js'
import { distanceInMeters } from '../domain/geo.js'
import type { Order } from '../domain/order.js'
import { resolvePickupScheduledAt, type PickupSchedule } from '../domain/pickup-schedule.js'
import type { Clock } from '../ports/clock.js'
import type { OrderRepository } from '../ports/order-repository.js'
import type { RoutingProvider } from '../ports/routing-provider.js'

export type CreateOrderCommand = {
  merchant: Merchant
  zone: Zone
  customerName: string
  customerPhone: string
  customerEmail?: string | undefined
  deliveryAddress: string
  deliveryLat: number
  deliveryLng: number
  pickupScheduledAt: PickupSchedule
  orderDetails?: string | undefined
  deliveryInstructions?: string | undefined
  deliveryAddressComplement?: string | undefined
  correlationId?: string
}

export class CreateOrderUseCase {
  public constructor(
    private readonly orderRepository: OrderRepository,
    private readonly routingProvider: RoutingProvider,
    private readonly clock: Clock
  ) {}

  public async execute(command: CreateOrderCommand): Promise<Order> {
    const { merchant, zone } = command
    const distanceToZoneCenterM = distanceInMeters(
      { lat: zone.centerLat, lng: zone.centerLng },
      { lat: command.deliveryLat, lng: command.deliveryLng }
    )
    if (distanceToZoneCenterM > zone.radiusKm * 1_000) {
      throw new DeliveryOutsideZoneError()
    }
    const pickupScheduledAt = resolvePickupScheduledAt(command.pickupScheduledAt, this.clock.now())

    // Le réseau reste strictement hors de la transaction de création.
    const route = await this.routingProvider.getRoute(
      { lat: merchant.lat, lng: merchant.lng },
      { lat: command.deliveryLat, lng: command.deliveryLng }
    )

    return this.orderRepository.create({
      merchantId: merchant.id,
      zoneId: merchant.zoneId,
      customerName: command.customerName,
      customerPhone: command.customerPhone,
      customerEmail: command.customerEmail ?? null,
      pickupScheduledAt,
      orderDetails: command.orderDetails ?? null,
      deliveryInstructions: command.deliveryInstructions ?? null,
      deliveryAddressComplement: command.deliveryAddressComplement ?? null,
      pickupAddress: merchant.address,
      pickupLat: merchant.lat,
      pickupLng: merchant.lng,
      deliveryAddress: command.deliveryAddress,
      deliveryLat: command.deliveryLat,
      deliveryLng: command.deliveryLng,
      distanceM: route.distanceM,
      durationS: route.durationS,
      actor: { type: 'merchant', id: merchant.id },
      correlationId: command.correlationId ?? randomUUID()
    })
  }
}
