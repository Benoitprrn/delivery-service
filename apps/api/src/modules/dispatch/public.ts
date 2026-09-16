import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import { config } from '../../platform/config.js'
import type { createDriversModule } from '../drivers/public.js'
import type { createOrdersModule } from '../orders/public.js'
import { AcceptDispatchOfferUseCase } from './application/accept-dispatch-offer.js'
import { ExpireDispatchOfferUseCase } from './application/expire-dispatch-offer.js'
import { GetDispatchOfferUseCase } from './application/get-dispatch-offer.js'
import { NotifyNextCandidateUseCase } from './application/notify-next-candidate.js'
import { ReconcileStuckDispatchesUseCase } from './application/reconcile-stuck-dispatches.js'
import { RejectDispatchOfferUseCase } from './application/reject-dispatch-offer.js'
import { StartDispatchUseCase } from './application/start-dispatch.js'
import { PgBossDispatchScheduler } from './infrastructure/pgboss-dispatch-scheduler.js'
import { PostgresDispatchRepository } from './infrastructure/postgres-dispatch-repository.js'
import { VroomDispatchPlanner } from './infrastructure/vroom-dispatch-planner.js'

export type { DispatchOffer } from './domain/dispatch-offer.js'
export type { DispatchAttempt, DispatchMetadata } from './domain/dispatch-metadata.js'
export { DispatchOfferAccessDeniedError, DispatchOfferConflictError, DispatchOfferNotFoundError, DispatchPlannerUnavailableError } from './domain/errors.js'
export type { DispatchRepository } from './ports/dispatch-repository.js'
export type { DispatchLocation, DispatchPlanStep, DispatchPlanner, DispatchPlannerInput, DispatchShipment } from './ports/dispatch-planner.js'
export { PostgresDispatchRepository } from './infrastructure/postgres-dispatch-repository.js'
export { VroomDispatchPlanner } from './infrastructure/vroom-dispatch-planner.js'
export { registerDispatchHttpRoutes } from './transport/http/routes.js'

type OrdersFacade = Pick<ReturnType<typeof createOrdersModule>,
  'findOrderById' | 'findDispatchMetadata' | 'findStuckAvailableOrders' |
  'findDriversWithActiveOrderForMerchant' | 'getDriverOrders' | 'markDispatchFailed' |
  'recordDispatchAttempt' | 'assignOrder' | 'findDriverOrderById'
>
type DriversFacade = Pick<ReturnType<typeof createDriversModule>,
  'isAvailable' | 'getCapacity' | 'findLatestDriverLocation' | 'findAvailableWithinRadius'
>

export function createDispatchModule(pool: Pool, vroomUrl: string, orders: OrdersFacade, drivers: DriversFacade, pgBoss: PgBoss) {
  const repository = new PostgresDispatchRepository(pool)
  const scheduler = new PgBossDispatchScheduler(pgBoss, config.DISPATCH_OFFER_TTL_SECONDS)
  const notify = new NotifyNextCandidateUseCase(repository, new VroomDispatchPlanner(vroomUrl), orders, drivers, scheduler, config.DISPATCH_OFFER_TTL_SECONDS)
  const start = new StartDispatchUseCase(repository, orders, drivers, notify)
  const accept = new AcceptDispatchOfferUseCase(repository, orders, drivers)
  const getOffer = new GetDispatchOfferUseCase(repository, orders)
  const reject = new RejectDispatchOfferUseCase(repository, orders, start)
  const expire = new ExpireDispatchOfferUseCase(repository, orders, start)
  const reconcile = new ReconcileStuckDispatchesUseCase(orders, start)

  return {
    startDispatch: start.execute.bind(start),
    acceptOffer: accept.execute.bind(accept),
    getOffer: getOffer.execute.bind(getOffer),
    rejectOffer: reject.execute.bind(reject),
    expireOffer: expire.execute.bind(expire),
    reconcileStuckDispatches: reconcile.execute.bind(reconcile),
    registerWorkers: () => scheduler.registerWorkers(expire, reconcile)
  }
}
