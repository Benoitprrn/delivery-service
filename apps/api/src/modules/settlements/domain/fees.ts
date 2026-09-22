import { InvalidAmountError } from './errors.js'

export const DEFAULT_FEE_RATE_BPS = 2_000
export const DEFAULT_FEE_RULE_VERSION = 1
export type LineFee = { earningCents: number; feeRateBps: number }

function assertAmount(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new InvalidAmountError() }
export function computeLineFee({ earningCents, feeRateBps }: LineFee): { feeCents: number; netCents: number } {
  assertAmount(earningCents)
  if (!Number.isSafeInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) throw new InvalidAmountError('Fee rate must be an integer from 0 to 10000 bps')
  const feeCents = Math.floor((earningCents * feeRateBps) / 10_000)
  return { feeCents, netCents: earningCents - feeCents }
}
export function sumStatementAmounts(lines: readonly LineFee[]): { grossCents: number; feeCents: number; dueCents: number } {
  return lines.reduce((totals, line) => {
    const { feeCents } = computeLineFee(line)
    return { grossCents: totals.grossCents + line.earningCents, feeCents: totals.feeCents + feeCents, dueCents: totals.dueCents + line.earningCents - feeCents }
  }, { grossCents: 0, feeCents: 0, dueCents: 0 })
}
