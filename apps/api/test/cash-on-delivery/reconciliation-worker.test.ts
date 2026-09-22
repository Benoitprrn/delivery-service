import { afterEach, describe, expect, it } from 'vitest'
import { startCashOnDeliveryReconciliationWorker } from '../../src/modules/cash-on-delivery/public.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const stoppers: Array<() => void> = []
function start(...args: Parameters<typeof startCashOnDeliveryReconciliationWorker>): () => void {
  const stop = startCashOnDeliveryReconciliationWorker(...args)
  stoppers.push(stop)
  return stop
}
afterEach(() => { for (const stop of stoppers.splice(0)) stop() })

describe('startCashOnDeliveryReconciliationWorker', () => {
  it('runs a cycle immediately and then on every interval', async () => {
    let cycles = 0
    start(async () => { cycles += 1 }, undefined, 20)
    await sleep(110)
    expect(cycles).toBeGreaterThanOrEqual(3)
  })

  it('stops for good when the returned function is called', async () => {
    let cycles = 0
    const stop = start(async () => { cycles += 1 }, undefined, 20)
    await sleep(60)
    stop()
    const atStop = cycles
    await sleep(100)
    expect(cycles).toBe(atStop)
  })

  it('never overlaps two cycles', async () => {
    let running = 0
    let peak = 0
    start(async () => {
      running += 1
      peak = Math.max(peak, running)
      await sleep(60)
      running -= 1
    }, undefined, 10)
    await sleep(250)
    expect(peak).toBe(1)
  })

  it('logs a failing cycle by error class only and keeps running', async () => {
    const errors: Array<{ object: Record<string, unknown>; message: string }> = []
    let cycles = 0
    start(async () => {
      cycles += 1
      if (cycles === 1) throw new Error('boom pi_1_secret_abc')
    }, {
      info: () => undefined,
      warn: () => undefined,
      error: (object, message) => { errors.push({ object, message }) }
    }, 20)
    await sleep(100)
    expect(cycles).toBeGreaterThanOrEqual(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.object).toMatchObject({ event: 'cod_reconciliation_cycle_failed', errorClass: 'Error' })
    expect(JSON.stringify(errors)).not.toContain('secret')
  })
})
