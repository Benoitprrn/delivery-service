import { EInvoiceNetworkBeforeSendError, EInvoiceUnknownOutcomeError, type EInvoiceEvent, type EInvoiceProvider, type EInvoiceSubmission } from '../ports/einvoice-provider.js'
import { SuperPdpOAuthClient } from './superpdp-oauth-client.js'

type SuperInvoice = { id: number }
type EventResponse = { data?: Array<{ id: number; invoice_id: number; status_code: string; status_text: string; created_at: string }>; has_after?: boolean }

export class SuperPdpEInvoiceProvider implements EInvoiceProvider {
  public constructor(private readonly baseUrl: string, private readonly oauth: SuperPdpOAuthClient, private readonly fetcher: typeof fetch = fetch) {}
  public submitInvoice(input: { externalId: string; enInvoice: Record<string, unknown> }): Promise<EInvoiceSubmission> { return this.submit(input) }
  public submitCreditNote(input: { externalId: string; enInvoice: Record<string, unknown> }): Promise<EInvoiceSubmission> { return this.submit(input) }
  public async getStatus(providerDocumentId: string): Promise<Record<string, unknown>> { return this.json(`/v1.beta/invoices/${encodeURIComponent(providerDocumentId)}`) }
  public async listEvents(startingAfterId: number): Promise<{ events: EInvoiceEvent[]; hasAfter: boolean }> {
    const result = await this.json<EventResponse>(`/v1.beta/invoice_events?starting_after_id=${startingAfterId}`)
    return { events: (result.data ?? []).map((event) => ({ id: event.id, invoiceId: String(event.invoice_id), statusCode: event.status_code, statusText: event.status_text, createdAt: new Date(event.created_at) })), hasAfter: result.has_after === true }
  }
  // `GET .../download` est documenté déprécié (prévu supprimé en v1) : jamais utilisé. Le rendu
  // humainement lisible passe par `?format=factur-x`, généré côté Super PDP à partir du document
  // XML déjà soumis — Locadely n'a jamais besoin de fournir son propre gabarit PDF pour l'obtenir.
  public async getDocument(providerDocumentId: string): Promise<{ content: Buffer; contentType: string }> {
    const response = await this.request(`/v1.beta/invoices/${encodeURIComponent(providerDocumentId)}?format=factur-x`)
    if (!response.ok) throw new Error(`Super PDP document retrieval failed with HTTP ${response.status}: ${await response.text()}`)
    return { content: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/pdf' }
  }
  private async submit(input: { externalId: string; enInvoice: Record<string, unknown> }): Promise<EInvoiceSubmission> {
    // `POST /v1.beta/invoices` n'accepte jamais de JSON (uniquement XML CII/UBL, PDF Factur-X, ou
    // multipart — confirmé dans le schéma de requête). Un Factur-X en sortie de `/convert` exige
    // de fournir NOUS-MÊMES un gabarit PDF en multipart (`requestBody.multipart/form-data` :
    // `pdf` + `invoice` tous deux requis) — que nous n'avons pas. `to=cii` donne une réponse
    // `application/xml` clairement documentée : c'est ce document XML, pas du JSON, qui est
    // soumis. Le rendu Factur-X lisible se récupère séparément après coup (`getDocument`).
    let canonicalXml: string
    try {
      const converted = await this.request('/v1.beta/invoices/convert?from=en16931&to=cii', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/xml' }, body: JSON.stringify(input.enInvoice) })
      if (!converted.ok) throw new Error(`Super PDP conversion failed with HTTP ${converted.status}: ${await converted.text()}`)
      canonicalXml = await converted.text()
    } catch (error) {
      // OAuth and conversion happen before the invoice POST: they are never an ambiguous submission.
      throw new EInvoiceNetworkBeforeSendError(errorMessage(error))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await this.request(`/v1.beta/invoices?processing_rule=B2B&external_id=${encodeURIComponent(input.externalId)}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: canonicalXml, signal: controller.signal })
    } catch (error) {
      // HTTP cannot prove whether a TCP failure happened before or after bytes were sent. These
      // standard network-code heuristics deliberately favour no duplicate invoice over certainty.
      if (isBeforeSendNetworkError(error)) throw new EInvoiceNetworkBeforeSendError(errorMessage(error))
      throw new EInvoiceUnknownOutcomeError(errorMessage(error))
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const message = `Super PDP submission failed with HTTP ${response.status}: ${await response.text()}`
      if (response.status === 429 || response.status >= 500) throw new EInvoiceNetworkBeforeSendError(message)
      throw new Error(message)
    }
    const invoice = await response.json() as SuperInvoice
    if (!Number.isInteger(invoice.id)) throw new Error('Super PDP submission response has no invoice id')
    return { providerDocumentId: String(invoice.id), document: Buffer.from(canonicalXml), contentType: 'application/xml' }
  }
  private async json<T = Record<string, unknown>>(path: string): Promise<T> { const response = await this.request(path); if (!response.ok) throw new Error(`Super PDP request failed with HTTP ${response.status}: ${await response.text()}`); return response.json() as Promise<T> }
  private async request(path: string, init: RequestInit = {}): Promise<Response> { const token = await this.oauth.accessToken(); const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`); return this.fetcher(`${this.baseUrl}${path}`, { ...init, headers }) }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'unknown_superpdp_error' }
function isBeforeSendNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code?: unknown }).code : undefined
  return code === 'ENOTFOUND' || code === 'ECONNREFUSED'
}
