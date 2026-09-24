import { describe, expect, it } from 'vitest'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../../src/modules/invoices/ports/einvoice-provider.js'
import { SuperPdpEInvoiceProvider } from '../../src/modules/invoices/infrastructure/superpdp-einvoice-provider.js'
import { SuperPdpOAuthClient } from '../../src/modules/invoices/infrastructure/superpdp-oauth-client.js'

const response = (body: string, status = 200, headers?: Record<string, string>) => new Response(body, { status, ...(headers === undefined ? {} : { headers }) })
function provider(post: () => Response | Promise<Response>): SuperPdpEInvoiceProvider {
  const fetcher = async (url: string): Promise<Response> => {
    if (url.endsWith('/oauth2/token')) return response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), 200, { 'content-type': 'application/json' })
    if (url.includes('/convert?')) return response('<xml/>', 200)
    return post()
  }
  return new SuperPdpEInvoiceProvider('https://superpdp.test', new SuperPdpOAuthClient('https://superpdp.test', 'id', 'secret', fetcher as typeof fetch), fetcher as typeof fetch)
}

describe('Super PDP submission error classification', () => {
  it.each([[429], [500], [503]])('retries HTTP %i', async (status) => {
    await expect(provider(() => response('temporary', status)).submitInvoice({ externalId: 'i', enInvoice: {} })).rejects.toBeInstanceOf(EInvoiceNetworkBeforeSendError)
  })
  it('keeps a deterministic POST 4xx generic so the worker fails it', async () => {
    await expect(provider(() => response('invalid', 422)).submitInvoice({ externalId: 'i', enInvoice: {} })).rejects.not.toBeInstanceOf(EInvoiceNetworkBeforeSendError)
  })
  it('retries DNS/connection errors diagnosed before sending', async () => {
    const error = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    await expect(provider(() => { throw error }).submitInvoice({ externalId: 'i', enInvoice: {} })).rejects.toBeInstanceOf(EInvoiceNetworkBeforeSendError)
  })
  it('marks a response-less timeout/reset as an unknown outcome', async () => {
    await expect(provider(() => { throw new DOMException('aborted', 'AbortError') }).submitInvoice({ externalId: 'i', enInvoice: {} })).rejects.toBeInstanceOf(EInvoiceUnknownOutcomeError)
  })
})
