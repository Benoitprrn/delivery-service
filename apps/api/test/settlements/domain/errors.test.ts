import { describe, expect, it } from 'vitest'
import { InvalidAmountError, NotAMondayError } from '../../../src/modules/settlements/public.js'

describe('settlement domain errors', () => {
  it('exposes stable error codes', () => {
    expect(new InvalidAmountError().code).toBe('INVALID_AMOUNT')
    expect(new NotAMondayError().code).toBe('NOT_A_MONDAY')
  })
})
