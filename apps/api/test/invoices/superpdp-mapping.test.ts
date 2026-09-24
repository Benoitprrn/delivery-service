import { describe, expect, it } from 'vitest'
import { CREDIT_NOTE_TYPE_CODE, euro, mapToEnInvoice, projectSubmissionStatus } from '../../src/modules/invoices/infrastructure/en16931-mapper.js'
import { DriverEInvoiceReadiness } from '../../src/modules/invoices/application/driver-einvoice-readiness.js'

const base = () => ({ id: 'i', number: 'F-1', invoiceTypeCode: '380' as const, issuedAt: new Date('2026-09-23T12:00:00Z'), currencyCode: 'EUR', totalHtCents: 1000, totalVatCents: 200, totalTtcCents: 1200, buyerReference: null, seller: { legalName: 'Seller', siren: '123456789', vatNumber: null, addressLine1: '1 rue A', addressLine2: null, postalCode: '01000', city: 'Bourg', countryCode: 'FR', electronicAddressScheme: null, electronicAddressValue: null }, buyer: { legalName: 'Buyer', siren: '987654321', vatNumber: null, addressLine1: '2 rue B', addressLine2: null, postalCode: '01000', city: 'Bourg', countryCode: 'FR', electronicAddress: { scheme: '0225', value: '987654321' } }, paymentTermsText: 'SEPA', paymentMeansTypeCode: '59', lines: [{ lineNumber: 1, description: 'Delivery', quantity: '1', unit: null, unitPriceHtCents: 1000, lineHtCents: 1000, lineVatCents: 200, vatRateBps: 2000, vatExemptionReasonText: null }] })

describe('Super PDP EN16931 mapping', () => {
  it('maps legal invoice codes as JSON integers and fills a legacy seller address without mutating it', () => { const invoice = base(); const out = mapToEnInvoice(invoice, '0225'); expect(out.type_code).toBe(380); expect((out.seller as { electronic_address: unknown }).electronic_address).toEqual({ scheme: '0225', value: '123456789' }); expect(invoice.seller.electronicAddressValue).toBeNull() })
  it('preserves 389 and emits the isolated standard credit note hypothesis 381', () => { const invoice = { ...base(), invoiceTypeCode: '389' as const }; expect(mapToEnInvoice(invoice, '0225').type_code).toBe(389); expect(mapToEnInvoice({ ...invoice, precedingInvoice: { number: 'F-0', issueDate: new Date('2026-01-01'), typeCode: 389 } }, '0225').type_code).toBe(CREDIT_NOTE_TYPE_CODE) })
  it('maps BT-10 buyer_reference only at the EN16931 top level when present', () => { expect(mapToEnInvoice({ ...base(), buyerReference: 'PO-42' }, '0225')).toMatchObject({ buyer_reference: 'PO-42' }); const absent = mapToEnInvoice(base(), '0225'); expect(absent).not.toHaveProperty('buyer_reference'); expect(absent.buyer).not.toHaveProperty('buyer_reference') })
  it('projects every confirmed lifecycle code cumulatively and tolerates unknown codes', () => {
    expect(projectSubmissionStatus(['api:uploaded', 'fr:200', 'api:validated', 'api:sent', 'fr:201', 'fr:202', 'fr:203', 'fr:206', 'fr:207', 'fr:208', 'fr:211', 'fr:212'])).toBe('submitted')
    expect(projectSubmissionStatus(['fr:200', 'fr:209', 'fr:200', 'fr:220'])).toBe('accepted')
    expect(projectSubmissionStatus(['api:accepted'])).toBe('accepted')
    expect(projectSubmissionStatus(['api:invalid'])).toBe('rejected')
    expect(projectSubmissionStatus(['api:rejected', 'fr:205', 'fr:210', 'fr:213'])).toBe('rejected')
    expect(projectSubmissionStatus(['fr:220'])).toBe('submitted')
  })
})
describe('euro() — conversion centimes entiers vers décimal EN16931, jamais une division flottante', () => {
  it.each([[1, '0.01'], [10, '0.10'], [101, '1.01'], [199, '1.99'], [1000, '10.00']])('%i cents -> %s', (cents, expected) => {
    expect(euro(cents)).toBe(expected)
  })
})
describe('DriverEInvoiceReadiness', () => { it.each([['absent', false], ['not verified', false], ['verified', true], ['revoked', false]])('accepts only an active verified mandate: %s', async (_case, expected) => { const readiness = new DriverEInvoiceReadiness({ hasVerifiedMandate: async () => expected }); await expect(readiness.isReady('driver')).resolves.toBe(expected) }) })
