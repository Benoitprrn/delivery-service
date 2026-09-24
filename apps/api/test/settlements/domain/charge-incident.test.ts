import { describe, expect, it } from 'vitest'
import { assessChargeIncidents, InvalidAmountError, type ChargeIncidentView } from '../../../src/modules/settlements/public.js'

const view = (over: Partial<ChargeIncidentView> = {}): ChargeIncidentView => ({ chargeId: 'ch_1', paymentIntentId: 'pi_1', chargeAmountCents: 1000, amountRefundedCents: 0, dispute: null, ...over })
describe('charge incidents', () => {
  it.each([['won', 'won'], ['lost', 'lost'], ['charge_refunded', 'lost'], ['warning_closed', 'closed'], ['warning_needs_response', 'open'], ['warning_under_review', 'open'], ['needs_response', 'open'], ['under_review', 'open'], ['future_status', 'open']])('maps dispute status %s to %s', (status, expected) => {
    const assessment = assessChargeIncidents(view({ dispute: { id: 'dp', status, amountCents: 300, reason: null } }))
    expect(assessment.incidents[0]?.status).toBe(expected)
  })
  it('keeps output ordered, caps restaurant debt and does not double count charge_refunded', () => {
    expect(assessChargeIncidents(view({ amountRefundedCents: 800, dispute: { id: 'dp', status: 'lost', amountCents: 500, reason: 'fraud' } }))).toMatchObject({ chargeUsable: false, restaurantOwedCents: 1000, incidents: [{ kind: 'dispute' }, { kind: 'refund', externalId: 'refund:ch_1' }] })
    expect(assessChargeIncidents(view({ amountRefundedCents: 800, dispute: { id: 'dp', status: 'charge_refunded', amountCents: 500, reason: null } }))).toMatchObject({ incidents: [{ kind: 'dispute' }], restaurantOwedCents: 500 })
  })
  it('uses a charge only with no incident or a won/closed dispute', () => {
    expect(assessChargeIncidents(view()).chargeUsable).toBe(true)
    expect(assessChargeIncidents(view({ dispute: { id: 'dp', status: 'won', amountCents: 2, reason: null } })).chargeUsable).toBe(true)
    expect(assessChargeIncidents(view({ dispute: { id: 'dp', status: 'warning_closed', amountCents: 2, reason: null } })).chargeUsable).toBe(true)
    expect(assessChargeIncidents(view({ amountRefundedCents: 1 })).chargeUsable).toBe(false)
  })
  it('excludes succeeded Locadely service refunds but retains an untracked refund remainder', () => {
    expect(assessChargeIncidents(view({ amountRefundedCents: 200 }), 200)).toMatchObject({ chargeUsable: true, incidents: [] })
    expect(assessChargeIncidents(view({ amountRefundedCents: 350 }), 200)).toMatchObject({ chargeUsable: false, restaurantOwedCents: 150, incidents: [{ kind: 'refund', amountCents: 150 }] })
  })
  it('rejects invalid monetary amounts', () => {
    expect(() => assessChargeIncidents(view({ chargeAmountCents: 1.2 }))).toThrow(InvalidAmountError)
    expect(() => assessChargeIncidents(view({ amountRefundedCents: 1001 }))).toThrow(InvalidAmountError)
    expect(() => assessChargeIncidents(view({ dispute: { id: 'dp', status: 'lost', amountCents: -1, reason: null } }))).toThrow(InvalidAmountError)
  })
})
