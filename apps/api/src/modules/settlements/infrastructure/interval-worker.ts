import type { SettlementLogger } from '../ports/settlement-close.js'

/** Boucle périodique sans chevauchement ; une erreur est journalisée (classe seulement) et retentée au cycle suivant. */
export function startIntervalWorker(label: string, run: () => Promise<unknown>, logger: SettlementLogger, intervalMs: number): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await run()
    } catch (error) {
      logger.error({ errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, `${label} cycle failed`)
    } finally {
      running = false
    }
  }
  void tick()
  const interval = setInterval(() => { void tick() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}
