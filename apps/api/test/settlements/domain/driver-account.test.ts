import { describe, expect, it } from 'vitest'
import { derivePayoutReadiness } from '../../../src/modules/settlements/public.js'

describe('driver account readiness', () => {
  it.each([
    [{ transfersStatus: 'active', requirementsState: 'current', payoutsStatus: 'inactive' }, 'ready'],
    [{ transfersStatus: 'inactive', requirementsState: 'current', payoutsStatus: 'active' }, 'blocked'],
    [{ transfersStatus: 'active', requirementsState: 'disabled', payoutsStatus: 'active' }, 'blocked'],
    [{ transfersStatus: 'active', requirementsState: 'past_due', payoutsStatus: 'active' }, 'blocked'],
  ] as const)('derives %s', (input, expected) => expect(derivePayoutReadiness(input)).toBe(expected))
})
