import type { PgBoss } from 'pg-boss'
import { DispatchOfferConflictError } from '../domain/errors.js'

export const DISPATCH_OFFER_EXPIRY_QUEUE = 'dispatch-offer-expiry'
export const DISPATCH_RECONCILIATION_QUEUE = 'dispatch-reconciliation'

type ExpireOffer = { execute(offerId: string, expectedVersion: number): Promise<void> }
type Reconcile = { execute(): Promise<void> }

export class PgBossDispatchScheduler {
  public constructor(private readonly pgBoss: PgBoss, private readonly offerTtlSeconds: number) {}

  public async scheduleOfferExpiration(offerId: string, expectedVersion: number): Promise<void> {
    await this.pgBoss.send(DISPATCH_OFFER_EXPIRY_QUEUE, { offerId, expectedVersion }, {
      startAfter: this.offerTtlSeconds,
      singletonKey: offerId
    })
  }

  public async registerWorkers(expireOffer: ExpireOffer, reconcile: Reconcile): Promise<void> {
    // pg-boss v12 requires a queue to exist before .work()/.schedule() can
    // target it — unlike older versions, it is no longer created implicitly.
    await this.pgBoss.createQueue(DISPATCH_OFFER_EXPIRY_QUEUE)
    await this.pgBoss.createQueue(DISPATCH_RECONCILIATION_QUEUE)
    await this.pgBoss.work<{ offerId: string; expectedVersion: number }>(DISPATCH_OFFER_EXPIRY_QUEUE, async ([job]) => {
      if (job === undefined) return
      try {
        await expireOffer.execute(job.data.offerId, job.data.expectedVersion)
      } catch (error) {
        // A concurrent HTTP response means this delayed job is already obsolete.
        if (error instanceof DispatchOfferConflictError) return
        throw error
      }
    })
    await this.pgBoss.work(DISPATCH_RECONCILIATION_QUEUE, async () => reconcile.execute())
    await this.pgBoss.schedule(DISPATCH_RECONCILIATION_QUEUE, '*/5 * * * *')
  }
}
