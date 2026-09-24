import type { RunServiceRefundsUseCase } from '../application/run-service-refunds.js'
import type { SettlementLogger } from '../ports/settlement-close.js'
export function startServiceRefundWorker(useCase: Pick<RunServiceRefundsUseCase, 'execute'>, logger: SettlementLogger, intervalMs = 60_000, clock: () => Date = () => new Date()): () => void {
  let running = false
  const run = async (): Promise<void> => { if (running) return; running = true; try { await useCase.execute({ now: clock() }) } catch (error) { logger.error({ errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Service refund cycle failed') } finally { running = false } }
  void run(); const interval = setInterval(() => { void run() }, intervalMs); interval.unref(); return () => clearInterval(interval)
}
