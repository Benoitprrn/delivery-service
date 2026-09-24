import { describe, expect, it } from 'vitest'
import { SuperPdpEInvoiceMandateProvider } from '../../src/modules/invoices/infrastructure/superpdp-einvoice-mandate-provider.js'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../../src/modules/invoices/ports/einvoice-provider.js'

function provider(fetcher: typeof fetch) { return new SuperPdpEInvoiceMandateProvider('https://example.test', { accessToken: async () => 'token' } as never, fetcher) }
const input = { grantorNumber: '123', grantorLegalName: 'Driver', pdf: Buffer.from('%PDF') }
describe('Super PDP mandate submission error classification', () => {
  it('classifies before-send DNS failures as retryable', async () => { const error = new Error('dns', { cause: { code: 'ENOTFOUND' } }); await expect(provider(async () => { throw error }).createMandate(input)).rejects.toBeInstanceOf(EInvoiceNetworkBeforeSendError) })
  it('classifies 429 and 5xx responses as retryable', async () => { for (const status of [429, 500]) await expect(provider(async () => new Response('down', { status })).createMandate(input)).rejects.toBeInstanceOf(EInvoiceNetworkBeforeSendError) })
  it('keeps 4xx responses terminal', async () => { await expect(provider(async () => new Response('bad', { status: 400 })).createMandate(input)).rejects.toBeInstanceOf(Error); await expect(provider(async () => new Response('bad', { status: 400 })).createMandate(input)).rejects.not.toBeInstanceOf(EInvoiceNetworkBeforeSendError) })
  it('classifies aborts after send as unknown outcomes', async () => { await expect(provider(async () => { throw new Error('aborted') }).createMandate(input)).rejects.toBeInstanceOf(EInvoiceUnknownOutcomeError) })
})
