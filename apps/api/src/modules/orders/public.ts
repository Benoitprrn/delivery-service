// Stub — contenu (domain/application/ports/infrastructure/transport) ajouté à l'étape 3.
import type { Pool } from 'pg'
import type { DriverAvailabilityReader } from './ports/driver-availability-reader.js'
import { AssignOrderUseCase } from './application/assign-order.js'
import { CollectOrderUseCase } from './application/collect-order.js'
import { CompleteOrderUseCase } from './application/complete-order.js'
import { ConfirmReturnUseCase, ReturnOrderUseCase } from './application/return-order.js'
import { CreateOrderUseCase } from './application/create-order.js'
import { EstimateOrderUseCase } from './application/estimate-order.js'
import { GetMerchantOrdersUseCase } from './application/get-merchant-orders.js'
import { GetDriverOrdersUseCase } from './application/get-driver-orders.js'
import { GetDriverHistoryUseCase } from './application/get-driver-history.js'
import { GetDriverEarningsUseCase } from './application/get-driver-earnings.js'
import { ListAvailableOrdersUseCase } from './application/list-available-orders.js'
import { OpenCageGeocodingProvider } from './infrastructure/opencage-geocoding-provider.js'
import { OsrmRoutingProvider } from './infrastructure/osrm-routing-provider.js'
import { SystemClock } from './infrastructure/system-clock.js'
import { PostgresOrderRepository } from './infrastructure/postgres-order-repository.js'

export type { Actor, AvailableOrder, DeliveryProofMethod, DriverHistoryOrder, DriverOrder, MerchantOrder, MerchantProofAsset, Order } from './domain/order.js'
export type { DriverEarnings, DriverCompletedOrderEarning } from './domain/driver-earnings.js'
export type { OrderEvent } from './domain/order-event.js'
export type { OrderWithEvents } from './domain/order-with-events.js'
export type { OrderStatus } from './domain/order-status.js'
export { ALLOWED_TRANSITIONS } from './domain/order-status.js'
export { canTransition, assertTransition } from './domain/order-state-machine.js'
export {
  DeliveryOutsideZoneError,
  InvalidTransitionError,
  InvalidZoneAssignmentError,
  MerchantNotFoundError,
  OrderConflictError,
  OrderNotFoundError,
  PastPickupScheduleError
} from './domain/errors.js'
export type { PickupSchedule } from './domain/pickup-schedule.js'
export { InvalidProofOfDeliveryError } from './domain/proof-of-delivery.js'
export { DeliveryCodeExpiredError, DeliveryCodeInvalidError, DeliveryCodeLockedError } from './domain/delivery-code.js'
export {
  AddressNotFoundError,
  GeocodingProviderResponseError,
  GeocodingUnavailableError
} from './ports/geocoding-provider.js'
export {
  RouteNotFoundError,
  RoutingProviderResponseError,
  RoutingUnavailableError
} from './ports/routing-provider.js'

export function createOrdersModule(
  pool: Pool,
  osrmBaseUrl: string,
  openCageApiKey: string,
  availabilityReader: DriverAvailabilityReader = { isAvailable: async () => true }
) {
  const repository = new PostgresOrderRepository(pool)
  const routingProvider = new OsrmRoutingProvider(osrmBaseUrl)
  const geocodingProvider = new OpenCageGeocodingProvider(openCageApiKey)
  const createOrderUseCase = new CreateOrderUseCase(repository, routingProvider, new SystemClock())
  const estimateOrderUseCase = new EstimateOrderUseCase(geocodingProvider, routingProvider)
  const getMerchantOrdersUseCase = new GetMerchantOrdersUseCase(repository)
  const getDriverOrdersUseCase = new GetDriverOrdersUseCase(repository)
  const getDriverHistoryUseCase = new GetDriverHistoryUseCase(repository)
  const getDriverEarningsUseCase = new GetDriverEarningsUseCase(repository)
  const listAvailableOrdersUseCase = new ListAvailableOrdersUseCase(repository, availabilityReader)
  const assignOrderUseCase = new AssignOrderUseCase(repository)
  const collectOrderUseCase = new CollectOrderUseCase(repository)
  const completeOrderUseCase = new CompleteOrderUseCase(repository)
  const returnOrderUseCase = new ReturnOrderUseCase(repository)
  const confirmReturnUseCase = new ConfirmReturnUseCase(repository)

  return {
    createOrder: createOrderUseCase.execute.bind(createOrderUseCase),
    estimateOrder: estimateOrderUseCase.execute.bind(estimateOrderUseCase),
    getMerchantOrders: getMerchantOrdersUseCase.execute.bind(getMerchantOrdersUseCase),
    getDriverOrders: getDriverOrdersUseCase.execute.bind(getDriverOrdersUseCase),
    getDriverHistory: getDriverHistoryUseCase.execute.bind(getDriverHistoryUseCase),
    getDriverEarnings: getDriverEarningsUseCase.execute.bind(getDriverEarningsUseCase),
    listAvailableOrders: listAvailableOrdersUseCase.execute.bind(listAvailableOrdersUseCase),
    assignOrder: assignOrderUseCase.execute.bind(assignOrderUseCase),
    collectOrder: collectOrderUseCase.execute.bind(collectOrderUseCase),
    completeOrder: completeOrderUseCase.execute.bind(completeOrderUseCase),
    returnOrder: returnOrderUseCase.execute.bind(returnOrderUseCase),
    confirmReturn: confirmReturnUseCase.execute.bind(confirmReturnUseCase)
  }
}
