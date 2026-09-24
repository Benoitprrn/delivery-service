import type { EInvoiceMandate, EInvoiceMandateProvider } from '../ports/einvoice-mandate-provider.js'
import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError } from '../ports/einvoice-provider.js'
import { SuperPdpOAuthClient } from './superpdp-oauth-client.js'

export class SuperPdpEInvoiceMandateProvider implements EInvoiceMandateProvider {
  public constructor(private readonly baseUrl: string, private readonly oauth: SuperPdpOAuthClient, private readonly fetcher: typeof fetch = fetch) {}
  public async createMandate(input: { grantorNumber: string; grantorNumberScheme?: 'fr_siren' | 'sandbox'; grantorLegalName: string; pdf: Buffer }): Promise<EInvoiceMandate> {
    // La partie `object` DOIT porter `Content-Type: application/json` explicitement — confirmé en
    // sandbox réel le 2026-09-23 : `form.set('object', <string>)` envoie `text/plain` par défaut
    // et Super PDP rejette alors TOUJOURS la requête avec le même message générique et trompeur
    // ("the body of this request must be a multipart with the json payload and the mandate in
    // pdf"), quel que soit le contenu JSON ou la validité du PDF. Un `Blob` typé, comme pour `pdf`
    // ci-dessous, est le seul moyen fiable de fixer ce Content-Type par partie avec `FormData`.
    const form = new FormData()
    form.set('object', new Blob([JSON.stringify({ direction: 'out', grantor_number_scheme: input.grantorNumberScheme ?? 'fr_siren', grantor_number: input.grantorNumber })], { type: 'application/json' }))
    form.set('pdf', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), 'mandate.pdf')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await this.request('/v1.beta/company_mandates', { method: 'POST', body: form, signal: controller.signal })
    } catch (error) {
      if (isBeforeSendNetworkError(error)) throw new EInvoiceNetworkBeforeSendError(errorMessage(error))
      throw new EInvoiceUnknownOutcomeError(errorMessage(error))
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const message = `Super PDP mandate request failed with HTTP ${response.status}: ${await response.text()}`
      if (response.status === 429 || response.status >= 500) throw new EInvoiceNetworkBeforeSendError(message)
      throw new Error(message)
    }
    return this.parse(response)
  }
  public async getMandate(providerMandateId: string): Promise<EInvoiceMandate> { return this.parse(await this.request(`/v1.beta/company_mandates/${encodeURIComponent(providerMandateId)}`)) }
  public async downloadMandate(providerMandateId: string): Promise<Buffer> { const r = await this.request(`/v1.beta/company_mandates/${encodeURIComponent(providerMandateId)}/download`); if (!r.ok) throw new Error(`Super PDP mandate download failed with HTTP ${r.status}: ${await r.text()}`); return Buffer.from(await r.arrayBuffer()) }
  private async parse(response: Response): Promise<EInvoiceMandate> { if (!response.ok) throw new Error(`Super PDP mandate request failed with HTTP ${response.status}: ${await response.text()}`); const body = await response.json() as { id?: number; verification_status?: 'verified' | 'not_verified' }; if (!Number.isInteger(body.id) || body.verification_status === undefined) throw new Error('Invalid Super PDP mandate response'); return { id: String(body.id), verificationStatus: body.verification_status } }
  private async request(path: string, init: RequestInit = {}): Promise<Response> { const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${await this.oauth.accessToken()}`); return this.fetcher(`${this.baseUrl}${path}`, { ...init, headers }) }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'unknown_superpdp_error' }
function isBeforeSendNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code?: unknown }).code : undefined
  return code === 'ENOTFOUND' || code === 'ECONNREFUSED'
}
