// Stub — contenu (domain/application/ports/infrastructure/transport) ajouté à l'étape 3.
import type { Pool } from 'pg'
import type { DriverAvailabilityReader } from './ports/driver-availability-reader.js'
import type { DriverCapacityWriter } from './ports/driver-capacity-writer.js'
import type { CardPaymentsReadiness } from './ports/card-payments-readiness.js'
import type { MerchantSettlementReadinessReader } from './ports/merchant-settlement-readiness.js'
import type { DriverEligibility } from './ports/driver-eligibility.js'
import type { DriverInvoiceReadiness } from './ports/driver-invoice-readiness.js'
import type { DriverCompanyProfileReadiness } from './ports/driver-company-profile-readiness.js'
import type { DriverMandateReadiness } from './ports/driver-mandate-readiness.js'
import { AssignOrderUseCase } from './application/assign-order.js'
import { CollectOrderUseCase } from './application/collect-order.js'
import { CompleteOrderUseCase } from './application/complete-order.js'
import { VerifyDeliveryCodeForCompletionUseCase } from './application/verify-delivery-code-for-completion.js'
import { ConfirmReturnUseCase, ReturnOrderUseCase } from './application/return-order.js'
import { UnassignOrderUseCase } from './application/unassign-order.js'
import { CreateOrderUseCase } from './application/create-order.js'
import { EstimateOrderUseCase } from './application/estimate-order.js'
import { GetMerchantOrdersUseCase } from './application/get-merchant-orders.js'
import { GetDriverOrdersUseCase } from './application/get-driver-orders.js'
import { GetDriverHistoryUseCase } from './application/get-driver-history.js'
import { GetDriverEarningsUseCase } from './application/get-driver-earnings.js'
import { GetOrderRouteUseCase } from './application/get-order-route.js'
import { GetOrderTrackingUseCase } from './application/get-order-tracking.js'
import { ListAvailableOrdersUseCase } from './application/list-available-orders.js'
import { OsrmRoutingProvider } from './infrastructure/osrm-routing-provider.js'
import { SystemClock } from './infrastructure/system-clock.js'
import { PostgresOrderRepository } from './infrastructure/postgres-order-repository.js'
import { createPricingSettingsReader } from '../pricing/public.js'
export { registerOrderHttpRoutes } from './transport/http/routes.js'

export type { Actor, AvailableOrder, DeliveryProofMethod, DriverHistoryOrder, DriverOrder, MerchantOrder, MerchantProofAsset, Order, OrderForDriver } from './domain/order.js'
export type {
  CompleteCollectedCashOnDeliveryCommand,
  CompleteCollectedCashOnDeliveryInput,
  VerifyDeliveryCodeForCompletionInput
} from './ports/order-repository.js'
export type { VerifyDeliveryCodeForCompletionCommand } from './application/verify-delivery-code-for-completion.js'
export type { OrderCashOnDelivery } from '@delivery-service/shared'
export type { DriverEarnings, DriverCompletedOrderEarning } from './domain/driver-earnings.js'
export type { CountExcludedOrdersInput, ListSettleableOrdersInput, SettleableFinalStatus, SettleableOrder } from './domain/settleable-order.js'
export type { OrderEvent } from './domain/order-event.js'
export type { OrderWithEvents } from './domain/order-with-events.js'
export type { OrderStatus } from './domain/order-status.js'
export { ALLOWED_TRANSITIONS } from './domain/order-status.js'
export { canTransition, assertTransition } from './domain/order-state-machine.js'
export {
  DeliveryOutsideZoneError,
  CashOnDeliveryAlreadyCollectedError,
  CardPaymentsNotReadyError,
  DriverPayoutAccountNotReadyError,
  DriverInvoiceInformationNotReadyError,
  DriverCompanyProfileNotReadyError,
  DriverMandateNotReadyError,
  MerchantPaymentSetupIncompleteError,
  CashOnDeliveryNotRequiredError,
  CashOnDeliveryPaymentRequiredError,
  InvalidTransitionError,
  InvalidZoneAssignmentError,
  MerchantNotFoundError,
  MerchantOnboardingIncompleteError,
  OrderConflictError,
  OrderNotFoundError,
  OrderRouteAccessDeniedError,
  PastPickupScheduleError
} from './domain/errors.js'
export type { PickupSchedule } from './domain/pickup-schedule.js'
export type { ActiveOrderTrackingReader, OrderTrackingRepository, OrderTrackingRecord } from './ports/order-tracking-repository.js'
export type { DriverCapacityWriter } from './ports/driver-capacity-writer.js'
export { createMerchantSettlementReadiness } from './infrastructure/merchant-settlement-readiness.js'
export type { MerchantSettlementReadiness, MerchantSettlementReadinessReader } from './ports/merchant-settlement-readiness.js'
export type { DriverEligibility } from './ports/driver-eligibility.js'
export type { DriverInvoiceReadiness } from './ports/driver-invoice-readiness.js'
export type { DriverCompanyProfileReadiness } from './ports/driver-company-profile-readiness.js'
export type { DriverMandateReadiness } from './ports/driver-mandate-readiness.js'
export { PostgresDriverInvoiceReadinessReader } from './infrastructure/postgres-driver-invoice-readiness.js'
export { GROUPAGE_WINDOW_MINUTES } from './domain/dispatch.js'
export type { DispatchAttempt, DispatchMetadata } from './domain/dispatch.js'
export { InvalidProofOfDeliveryError } from './domain/proof-of-delivery.js'
export { DeliveryCodeExpiredError, DeliveryCodeInvalidError, DeliveryCodeLockedError } from './domain/delivery-code.js'
export {
  RouteNotFoundError,
  RoutingProviderResponseError,
  RoutingUnavailableError
} from './ports/routing-provider.js'

export function createOrdersModule(
  pool: Pool,
  osrmBaseUrl: string,
  geocode: (address: string) => Promise<{ lat: number; lng: number }>,
  availabilityReader: DriverAvailabilityReader = { isAvailable: async () => true },
  capacityWriter: DriverCapacityWriter = { increment: async () => undefined, decrement: async () => undefined },
  // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde (fail-closed).
  cardPaymentsReadiness: CardPaymentsReadiness = { isReady: async () => true },
  settlementReadiness: MerchantSettlementReadinessReader = { check: async () => ({ ready: true }) },
  driverEligibility: DriverEligibility = { isEligible: async () => true },
  driverInvoiceReadiness: DriverInvoiceReadiness = { isReady: async () => true },
  // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde D-CP (fail-closed).
  driverCompanyProfileReadiness: DriverCompanyProfileReadiness = { isReady: async () => true },
  // Défaut permissif réservé aux tests du module : `app.ts` injecte toujours la vraie garde D-MD (fail-closed).
  driverMandateReadiness: DriverMandateReadiness = { isReady: async () => true }
) {
  const pricingSettings = createPricingSettingsReader(pool)
  const repository = new PostgresOrderRepository(pool, pricingSettings)
  const routingProvider = new OsrmRoutingProvider(osrmBaseUrl)
  const createOrderUseCase = new CreateOrderUseCase(repository, routingProvider, new SystemClock(), cardPaymentsReadiness, settlementReadiness)
  const estimateOrderUseCase = new EstimateOrderUseCase({ geocode }, routingProvider, pricingSettings)
  const getMerchantOrdersUseCase = new GetMerchantOrdersUseCase(repository)
  const getDriverOrdersUseCase = new GetDriverOrdersUseCase(repository)
  const getDriverHistoryUseCase = new GetDriverHistoryUseCase(repository)
  const getDriverEarningsUseCase = new GetDriverEarningsUseCase(repository)
  const getOrderRouteUseCase = new GetOrderRouteUseCase(repository, routingProvider)
  const getOrderTrackingUseCase = new GetOrderTrackingUseCase(repository)
  const listAvailableOrdersUseCase = new ListAvailableOrdersUseCase(repository, availabilityReader, driverEligibility, driverInvoiceReadiness, driverCompanyProfileReadiness, driverMandateReadiness)
  const assignOrderUseCase = new AssignOrderUseCase(repository, capacityWriter, driverEligibility, driverInvoiceReadiness, driverCompanyProfileReadiness, driverMandateReadiness)
  const collectOrderUseCase = new CollectOrderUseCase(repository)
  const completeOrderUseCase = new CompleteOrderUseCase(repository, capacityWriter)
  const verifyDeliveryCodeForCompletionUseCase = new VerifyDeliveryCodeForCompletionUseCase(repository)
  const returnOrderUseCase = new ReturnOrderUseCase(repository)
  const confirmReturnUseCase = new ConfirmReturnUseCase(repository, capacityWriter)
  const unassignOrderUseCase = new UnassignOrderUseCase(repository, capacityWriter)

  return {
    createOrder: createOrderUseCase.execute.bind(createOrderUseCase),
    estimateOrder: estimateOrderUseCase.execute.bind(estimateOrderUseCase),
    getMerchantOrders: getMerchantOrdersUseCase.execute.bind(getMerchantOrdersUseCase),
    getDriverOrders: getDriverOrdersUseCase.execute.bind(getDriverOrdersUseCase),
    getDriverHistory: getDriverHistoryUseCase.execute.bind(getDriverHistoryUseCase),
    getDriverEarnings: getDriverEarningsUseCase.execute.bind(getDriverEarningsUseCase),
    getOrderRoute: getOrderRouteUseCase.execute.bind(getOrderRouteUseCase),
    getOrderTracking: getOrderTrackingUseCase.execute.bind(getOrderTrackingUseCase),
    findOrderById: repository.findById.bind(repository),
    listSettleableOrders: repository.listSettleableOrders.bind(repository),
    countPreGoLiveFinalizedOrders: repository.countPreGoLiveFinalizedOrders.bind(repository),
    findDriverOrderById: repository.findDriverOrderById.bind(repository),
    findOrderForDriver: repository.findOrderForDriver.bind(repository),
    findDispatchMetadata: repository.findDispatchMetadata.bind(repository),
    findStuckAvailableOrders: repository.findStuckAvailableOrders.bind(repository),
    findActiveTrackingTokensByDriverId: repository.findActiveTrackingTokensByDriverId.bind(repository),
    findDriversWithActiveOrderForMerchant: repository.findDriversWithActiveOrderForMerchant.bind(repository),
    recordDispatchAttempt: repository.recordDispatchAttempt.bind(repository),
    markDispatchFailed: repository.markDispatchFailed.bind(repository),
    listAvailableOrders: listAvailableOrdersUseCase.execute.bind(listAvailableOrdersUseCase),
    assignOrder: assignOrderUseCase.execute.bind(assignOrderUseCase),
    collectOrder: collectOrderUseCase.execute.bind(collectOrderUseCase),
    completeOrder: completeOrderUseCase.execute.bind(completeOrderUseCase),
    verifyDeliveryCodeForCompletion: verifyDeliveryCodeForCompletionUseCase.execute.bind(verifyDeliveryCodeForCompletionUseCase),
    completeCollectedCashOnDeliveryInTransaction: repository.completeCollectedCashOnDeliveryInTransaction.bind(repository),
    releaseDriverCapacity: capacityWriter.decrement.bind(capacityWriter),
    returnOrder: returnOrderUseCase.execute.bind(returnOrderUseCase),
    confirmReturn: confirmReturnUseCase.execute.bind(confirmReturnUseCase),
    unassignOrder: unassignOrderUseCase.execute.bind(unassignOrderUseCase)
  }
}
