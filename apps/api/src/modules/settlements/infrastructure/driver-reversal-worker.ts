import type { ExecuteDriverReversalsUseCase } from '../application/driver-reversals.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

/** Cycle toutes les 60 s, sans chevauchement ; n'exécute QUE des reversals déjà approuvées par une seconde personne. */
export function startDriverReversalWorker(
  useCase: Pick<ExecuteDriverReversalsUseCase, 'execute'>,
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
      logger.error({ errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Driver reversal cycle failed')
    } finally {
      running = false
    }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}
