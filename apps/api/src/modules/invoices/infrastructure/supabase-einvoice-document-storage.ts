import type { EInvoiceDocumentStorage } from '../ports/einvoice-document-storage.js'

const BUCKET = 'einvoice-documents'

export class SupabaseEInvoiceDocumentStorage implements EInvoiceDocumentStorage {
  public constructor(private readonly url: string, private readonly key: string | undefined) {}

  private headers(contentType?: string, extra?: HeadersInit): HeadersInit {
    if (this.key === undefined) throw new Error('SUPABASE_SECRET_KEY is required for electronic invoice documents')
    return { authorization: `Bearer ${this.key}`, apikey: this.key, ...(contentType === undefined ? {} : { 'content-type': contentType }), ...extra }
  }

  // `x-upsert` : deux requêtes concurrentes peuvent toutes deux voir `document_storage_path` nul
  // (aucun verrou applicatif sur ce premier accès) et tenter d'écrire le même chemin — sans cet
  // en-tête, la seconde échouerait avec « resource already exists » au lieu de simplement
  // écraser un contenu byte-pour-byte identique (même provider, même document).
  public async uploadDocument(input: { path: string; content: Buffer; contentType: string }): Promise<void> {
    const response = await fetch(`${this.url}/storage/v1/object/${BUCKET}/${input.path}`, { method: 'POST', headers: this.headers(input.contentType, { 'x-upsert': 'true' }), body: new Uint8Array(input.content) })
    if (!response.ok) throw new Error(`Supabase Storage upload responded with ${response.status}`)
  }

  public async createSignedDocumentUrl(path: string, expiresInSeconds = 300): Promise<string> {
    const response = await fetch(`${this.url}/storage/v1/object/sign/${BUCKET}/${path}`, { method: 'POST', headers: this.headers('application/json'), body: JSON.stringify({ expiresIn: expiresInSeconds }) })
    if (!response.ok) throw new Error(`Supabase Storage signing responded with ${response.status}`)
    const body = await response.json() as { signedURL: string }
    return `${this.url}/storage/v1${body.signedURL}`
  }
}
