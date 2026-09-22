import { CloseSettlementPeriodUseCase, GoLiveNotSetError } from '../application/close-settlement-period.js'
import type { SettlementLogger } from '../ports/settlement-close.js'

/**
 * Worker de clôture hebdomadaire : vérifie chaque minute s'il reste une période exigible (lundi 00:05 Europe/Paris) non
 * clôturée. Sans `go_live_at` il ne fait RIEN (état normal avant la mise en production). Un cycle ne chevauche jamais le
 * précédent ; une erreur est journalisée (classe d'erreur seulement) et retentée au cycle suivant.
 */
export function startSettlementCloseWorker(
  useCase: Pick<CloseSettlementPeriodUseCase, 'execute'>,
  logger: SettlementLogger,
  intervalMs = 60_000,
  clock: () => Date = () => new Date()
): () => void {
  let running = false
  let goLiveNoticeLogged = false
  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const closed = (await useCase.execute({ now: clock() })).filter((summary) => summary.status === 'closed')
      for (const summary of closed) {
        logger.info({ closingMonday: summary.closingMonday, lines: summary.lines, statements: summary.statements, merchantAmountCents: summary.merchantAmountCents, excludedOrdersCount: summary.excludedOrdersCount }, 'Settlement period closed')
      }
    } catch (error) {
      if (error instanceof GoLiveNotSetError) {
        if (!goLiveNoticeLogged) logger.info({}, 'Settlement close worker idle: go_live_at is not set')
        goLiveNoticeLogged = true
      } else {
        logger.error({ errorClass: error instanceof Error ? error.constructor.name : 'UnknownError' }, 'Settlement close cycle failed')
      }
    } finally {
      running = false
    }
  }
  void run()
  const interval = setInterval(() => { void run() }, intervalMs)
  interval.unref()
  return () => clearInterval(interval)
}
