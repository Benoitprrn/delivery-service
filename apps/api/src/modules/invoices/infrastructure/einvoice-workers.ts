import type { PollEInvoiceEventsUseCase } from '../application/poll-einvoice-events.js'
import type { RunEInvoiceSubmissionsUseCase } from '../application/run-einvoice-submissions.js'
import type { RunEInvoiceMandateSubmissionsUseCase } from '../application/run-einvoice-mandate-submissions.js'
import type { PollEInvoiceMandatesUseCase } from '../application/poll-einvoice-mandates.js'

type WorkerLogger = { error(bindings: Record<string, unknown>, message: string): void }

/** Periodic submission loop: starts immediately, never overlaps, and leaves retry timing to the repository/use case. */
export function startEInvoiceSubmissionWorker(
  useCase: Pick<RunEInvoiceSubmissionsUseCase, 'execute'>,
  logger: WorkerLogger,
  intervalMs = 30_000,
  clock: () => Date = () => new Date()
): () => void {
  return startEInvoiceWorker('E-invoice submission', () => useCase.execute(clock()), logger, intervalMs)
}

/** Periodic polling loop: one cycle consumes every currently available Super PDP page. */
export function startEInvoicePollingWorker(
  useCase: Pick<PollEInvoiceEventsUseCase, 'execute'>,
  logger: WorkerLogger,
  intervalMs = 300_000,
  clock: () => Date = () => new Date()
): () => void {
  return startEInvoiceWorker('E-invoice polling', () => useCase.execute(clock()), logger, intervalMs)
}

export function startEInvoiceMandateSubmissionWorker(
  useCase: Pick<RunEInvoiceMandateSubmissionsUseCase, 'execute'>,
  logger: WorkerLogger,
  intervalMs = 30_000,
  clock: () => Date = () => new Date()
): () => void { return startEInvoiceWorker('E-invoice mandate submission', () => useCase.execute(clock()), logger, intervalMs) }

export function startEInvoiceMandatePollingWorker(
  useCase: Pick<PollEInvoiceMandatesUseCase, 'execute'>,
  logger: WorkerLogger,
  intervalMs = 300_000,
  clock: () => Date = () => new Date()
): () => void { return startEInvoiceWorker('E-invoice mandate polling', () => useCase.execute(clock()), logger, intervalMs) }

function startEInvoiceWorker(label: string, run: () => Promise<void>, logger: WorkerLogger, intervalMs: number): () => void {
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
