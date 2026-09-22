import { describe, expect, it } from 'vitest'
import { buildTransferIdempotencyKey, nextTryNo } from '../../../src/modules/settlements/public.js'

describe('transfer idempotency', () => {
  it('keeps the same try after an unknown outcome and increments only after final 4xx', () => {
    expect(buildTransferIdempotencyKey({ statementId: 'stmt_1', chargeId: 'ch_1', tryNo: 1 })).toBe('stmt:stmt_1:charge:ch_1:try:1')
    expect(nextTryNo(1, 'unknown')).toBe(1); expect(nextTryNo(1, 'definitive_4xx')).toBe(2)
  })
  it.each([{ statementId: '', chargeId: 'ch', tryNo: 1 }, { statementId: 'a:b', chargeId: 'ch', tryNo: 1 }, { statementId: 'a', chargeId: 'ch', tryNo: 0 }])('rejects ambiguous key input', (input) => expect(() => buildTransferIdempotencyKey(input)).toThrow())
})
