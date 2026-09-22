import { describe, expect, it, vi } from 'vitest'
import {
  CloseSettlementPeriodUseCase,
  GoLiveNotSetError,
  type ClosedPeriodSummary,
  type SettleableOrdersReader,
  type SettlementCloseRepository
} from '../../src/modules/settlements/public.js'

// Orchestration pure (fakes, aucune base) : rattrapage, idempotence, refus sans go_live_at, simulation sans écriture.
function harness(over: { goLiveAt?: Date | null; closed?: Set<number> } = {}) {
  const closed = over.closed ?? new Set<number>()
  const closePeriod = vi.fn(async (input: { periodStart: Date }) => { closed.add(input.periodStart.getTime()); return 'closed' as const })
  const repository: SettlementCloseRepository = {
    readSettings: async () => ({ goLiveAt: over.goLiveAt === undefined ? new Date('2026-08-15T00:00:00.000Z') : over.goLiveAt, feeRateBps: 2000, feeRuleVersion: 1, payrunDelayBusinessDays: 7, promiseBusinessDays: 15 }),
    isPeriodClosed: async (periodStart) => closed.has(periodStart.getTime()),
    closePeriod
  }
  const orders: SettleableOrdersReader = {
    listSettleableOrders: vi.fn(async () => []),
    countPreGoLiveFinalizedOrders: vi.fn(async () => 2)
  }
  return { useCase: new CloseSettlementPeriodUseCase(repository, orders), closePeriod, orders, closed }
}
const summaryMondays = (s: ClosedPeriodSummary[]) => s.map((x) => x.closingMonday)

describe('CloseSettlementPeriodUseCase', () => {
  it('refuses to close anything while go_live_at is not set', async () => {
    const { useCase, closePeriod } = harness({ goLiveAt: null })
    await expect(useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z') })).rejects.toBeInstanceOf(GoLiveNotSetError)
    expect(closePeriod).not.toHaveBeenCalled()
  })

  it('closes every due week since go_live_at, OLDEST FIRST, at Monday 00:05 Europe/Paris (catch-up)', async () => {
    const { useCase, closePeriod } = harness()
    // 2026-08-31 00:05 Paris (UTC+2) = 2026-08-30T22:05Z
    const summaries = await useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z') })
    expect(summaryMondays(summaries)).toEqual(['2026-08-17', '2026-08-24', '2026-08-31'])
    expect(summaries.every((s) => s.status === 'closed')).toBe(true)
    expect(closePeriod.mock.calls.map(([input]) => input.periodStart.toISOString())).toEqual(['2026-08-09T22:00:00.000Z', '2026-08-16T22:00:00.000Z', '2026-08-23T22:00:00.000Z'])
    expect(summaries[2]).toMatchObject({ debitDate: '2026-09-02', promiseDeadline: '2026-09-21', excludedOrdersCount: 2 })
    expect(summaries[2]?.payrunAtUtc.toISOString()).toBe('2026-09-11T08:00:00.000Z')
  })

  it('does not close a week one minute before Monday 00:05 Paris', async () => {
    const { useCase } = harness()
    const summaries = await useCase.execute({ now: new Date('2026-08-30T22:04:59.999Z') })
    expect(summaryMondays(summaries)).toEqual(['2026-08-17', '2026-08-24'])
  })

  it('is idempotent: closed periods are skipped and a second run does nothing', async () => {
    const { useCase, closePeriod } = harness()
    await useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z') })
    closePeriod.mockClear()
    await expect(useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z') })).resolves.toEqual([])
    expect(closePeriod).not.toHaveBeenCalled()
  })

  it('never goes back before the go_live_at week and stops at the first already closed period', async () => {
    const closedAlready = new Set<number>([new Date('2026-08-09T22:00:00.000Z').getTime()])
    const { useCase } = harness({ closed: closedAlready })
    expect(summaryMondays(await useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z') }))).toEqual(['2026-08-24', '2026-08-31'])
  })

  it('dry run computes everything and writes nothing', async () => {
    const { useCase, closePeriod } = harness()
    const summaries = await useCase.execute({ now: new Date('2026-08-30T22:05:00.000Z'), dryRun: true })
    expect(summaries).toHaveLength(3)
    expect(summaries.every((s) => s.status === 'dry_run')).toBe(true)
    expect(closePeriod).not.toHaveBeenCalled()
  })
})
