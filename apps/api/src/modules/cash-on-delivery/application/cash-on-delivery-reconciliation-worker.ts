import { COD_RECONCILIATION_INTERVAL_MS } from '../domain/reconciliation-policy.js'
import { noopCashOnDeliveryReconciliationLogger, type CashOnDeliveryReconciliationLogger } from './reconcile-cash-on-delivery-payments.js'

/**
 * Worker de réconciliation COD : un cycle à la fois (jamais de chevauchement), chaque
 * échec journalisé sans arrêter le worker. La fonction retournée l'arrête : plus aucun
 * nouveau cycle ne démarre (un cycle déjà en cours va au bout de son lot).
 */
export function startCashOnDeliveryReconciliationWorker(
  cycle: () => Promise<unknown>,
  logger: CashOnDeliveryReconciliationLogger = noopCashOnDeliveryReconciliationLogger,
  intervalMs: number = COD_RECONCILIATION_INTERVAL_MS
): () => void {
  let running = false
  let stopped = false
  const run = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await cycle()
    } catch (error) {
      logger.error(
        { event: 'cod_reconciliation_cycle_failed', errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' },
        'Cash on delivery reconciliation cycle failed'
      )
    } finally {
      running = false
    }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => {
    stopped = true
    clearInterval(interval)
  }
}
