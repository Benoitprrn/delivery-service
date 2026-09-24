import { describe, expect, it } from 'vitest'
import { canSubmitElectronicInvoice } from '../../src/modules/invoices/domain/transmission-readiness.js'
const ready = { status: 'ready' as const, electronicAddress: { scheme: '0225', value: 'x' } }
const check = (input: Partial<Parameters<typeof canSubmitElectronicInvoice>[0]> = {}) => canSubmitElectronicInvoice({ issuerKind: 'locadely', sellerElectronicAddressPresent: true, driverMandateVerified: true, buyerDirectory: ready, ...input })
describe('canSubmitElectronicInvoice', () => {
  it('allows a ready locadely issuer and a verified driver', () => { expect(check()).toEqual({ status: 'ready' }); expect(check({ issuerKind: 'driver', driverMandateVerified: true })).toEqual({ status: 'ready' }) })
  it('maps unavailable directory states to waiting and ambiguity to invalid', () => { expect(check({ buyerDirectory: { status: 'not_addressable' } })).toEqual({ status: 'waiting_for_recipient_address' }); expect(check({ buyerDirectory: { status: 'lookup_failed' } })).toEqual({ status: 'waiting_for_recipient_address' }); expect(check({ buyerDirectory: { status: 'ambiguous' } })).toEqual({ status: 'invalid_recipient_configuration' }) })
  it('prioritizes seller address then driver mandate', () => { expect(check({ sellerElectronicAddressPresent: false, issuerKind: 'driver', driverMandateVerified: false })).toEqual({ status: 'missing_seller_electronic_address' }); expect(check({ issuerKind: 'driver', driverMandateVerified: false })).toEqual({ status: 'waiting_for_mandate' }) })
})
