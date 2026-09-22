import type { RunDriverPayoutsUseCase } from '../application/run-driver-payouts.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

/** Cycle toutes les 60 s, sans chevauchement ; une erreur est journalisée (classe seulement) et retentée au cycle suivant. */
export function startDriverPayoutWorker(
  useCase: Pick<RunDriverPayoutsUseCase, 'execute'>,
  logger: SettlementLogger,
  intervalMs = 60_000,
  clock: () => Date = () => new Date()
): () => void {
  let running = false
  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await useCase.execute({ now: clock() })
    } catch (error) {
      logger.error({ errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Driver payout cycle failed')
    } finally {
      running = false
    }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}
