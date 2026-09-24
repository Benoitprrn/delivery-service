import type { Pool, PoolClient } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import type { CreditNoteDocument, InvoiceDocument, InvoiceRepository, OrderDocuments } from '../ports/invoice-repository.js'

type OrderRow = { id: string; status: string; driver_id: string | null; merchant_id: string; public_reference: string; delivery_cents: number | null; service_fee_cents: number | null; completed_at: Date | null }
type LegalRow = { legal_name: string; siren: string; siret: string; vat_number: string | null; vat_regime: 'assujetti' | 'franchise_en_base' | 'exonere' | null; address_line1: string; address_line2: string | null; address_postal_code: string; address_city: string; address_country_code: string }
type SubmissionStatus = 'prepared' | 'submitting' | 'submitted' | 'accepted' | 'rejected' | 'retryable' | 'failed' | 'unknown_outcome'
type InvoiceRow = { id: string; number: string; issuer_kind: 'driver' | 'locadely'; invoice_type_code: '380' | '389'; issued_at: Date; total_ht_cents: number; total_vat_cents: number; total_ttc_cents: number; transmission_status: string; submission_status: SubmissionStatus; last_error: string | null }
type CreditRow = { id: string; number: string; original_invoice_number: string; issued_at: Date; total_ht_cents: number; total_vat_cents: number; total_ttc_cents: number; transmission_status: string; submission_status: SubmissionStatus; last_error: string | null }

export class InvoiceIssuanceDeferredError extends Error {
  public constructor(public readonly reason: 'driver_legal_information_incomplete' | 'platform_legal_identity_incomplete' | 'merchant_legal_information_incomplete') {
    super(`Invoice issuance deferred: ${reason}`)
    this.name = 'InvoiceIssuanceDeferredError'
  }
}

const VAT_EXEMPTION_FRANCHISE = 'TVA non applicable, art. 293 B du CGI'
const VAT_EXEMPTION_EXONERE = 'TVA exonérée'
const locadelySequenceDriverId = '00000000-0000-0000-0000-000000000000'

function vat(regime: LegalRow['vat_regime']): { rate: number; reason: string | null } {
  if (regime === 'assujetti') return { rate: 2000, reason: null }
  if (regime === 'franchise_en_base') return { rate: 0, reason: VAT_EXEMPTION_FRANCHISE }
  return { rate: 0, reason: VAT_EXEMPTION_EXONERE }
}

// Les centimes sont des entiers : le calcul TVA ne passe jamais par une virgule flottante.
function vatCentsFor(htCents: number, rateBps: number): number {
  return Number((BigInt(htCents) * BigInt(rateBps)) / 10_000n)
}

function invoiceDocument(row: InvoiceRow): InvoiceDocument {
  return { id: row.id, number: row.number, issuerKind: row.issuer_kind, invoiceTypeCode: row.invoice_type_code, issuedAt: row.issued_at, totalHtCents: row.total_ht_cents, totalVatCents: row.total_vat_cents, totalTtcCents: row.total_ttc_cents, transmissionStatus: row.transmission_status, submissionStatus: row.submission_status, lastError: row.last_error, facturXAvailable: row.transmission_status === 'confirmed' }
}
function creditDocument(row: CreditRow): CreditNoteDocument {
  return { id: row.id, number: row.number, originalInvoiceNumber: row.original_invoice_number, issuedAt: row.issued_at, totalHtCents: row.total_ht_cents, totalVatCents: row.total_vat_cents, totalTtcCents: row.total_ttc_cents, transmissionStatus: row.transmission_status, submissionStatus: row.submission_status, lastError: row.last_error, facturXAvailable: row.transmission_status === 'confirmed' }
}

export class PostgresInvoiceRepository implements InvoiceRepository {
  // `electronicAddressScheme` (BT-34, ex. "0225" Peppol France) est une simple valeur de
  // configuration injectée par l'appelant (app.ts, depuis config.SUPERPDP_ELECTRONIC_ADDRESS_
  // SCHEME) — ce repository ne connaît jamais Super PDP lui-même, seulement une chaîne à
  // snapshotter. Voir ADR 0007 §3 : la valeur, elle, reste toujours le SIREN déjà détenu en
  // interne, jamais une donnée à récupérer ailleurs.
  public constructor(private readonly pool: Pool, private readonly electronicAddressScheme: string) {}

  public async issueForCompletedOrder(orderId: string): Promise<'issued' | 'already_issued' | 'legacy_or_not_completed'> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const order = (await client.query<OrderRow>('select id, status, driver_id, merchant_id, public_reference, delivery_cents, service_fee_cents, completed_at from orders where id = $1 for update', [orderId])).rows[0]
        if (order === undefined || order.status !== 'COMPLETED' || order.delivery_cents === null || order.service_fee_cents === null || order.driver_id === null || order.completed_at === null) return 'legacy_or_not_completed'
        const buyer = await this.merchantLegal(client, order.merchant_id)
        if (buyer === null) throw new InvoiceIssuanceDeferredError('merchant_legal_information_incomplete')
        const driver = await this.driverLegal(client, order.driver_id)
        if (driver === null) throw new InvoiceIssuanceDeferredError('driver_legal_information_incomplete')
        const platform = await this.platformLegal(client)
        if (platform === null) throw new InvoiceIssuanceDeferredError('platform_legal_identity_incomplete')
        await this.insertInvoice(client, order, buyer, driver, 'driver', order.delivery_cents)
        await this.insertInvoice(client, order, buyer, platform, 'locadely', order.service_fee_cents)
        return 'issued'
      })
    } catch (error) {
      if (isUniqueViolation(error)) return 'already_issued'
      throw error
    }
  }

  public async listForMerchantOrder(orderId: string, merchantId: string): Promise<OrderDocuments | null> { return this.list(orderId, merchantId, null) }
  public async listForDriverOrder(orderId: string, driverId: string): Promise<OrderDocuments | null> { return this.list(orderId, null, driverId) }

  public async createCreditNote(input: { originalInvoiceLineId: string; decisionReference: string; decisionReason: string; lineHtCents: number }): Promise<CreditNoteDocument> {
    return inTransaction(this.pool, async (client) => {
      const original = (await client.query<{ invoice_id: string; issuer_kind: 'driver' | 'locadely'; issuer_driver_id: string | null; buyer_merchant_id: string; order_id: string; order_public_reference: string; seller_siren: string; vat_rate_bps: number }>(
        `select il.invoice_id, i.issuer_kind, i.issuer_driver_id, i.buyer_merchant_id, i.order_id, i.order_public_reference, i.seller_siren, il.vat_rate_bps
         from invoice_lines il join invoices i on i.id = il.invoice_id where il.id = $1 for key share`, [input.originalInvoiceLineId]
      )).rows[0]
      if (original === undefined) throw new Error('Original invoice line was not found')
      const issuerDriverId = original.issuer_kind === 'driver' ? original.issuer_driver_id : locadelySequenceDriverId
      if (issuerDriverId === null) throw new Error('Driver invoice has no issuer driver')
      const number = await this.assignNumber(client, 'credit_note', original.issuer_kind, issuerDriverId, original.issuer_kind === 'driver' ? original.seller_siren : null)
      const vatCents = vatCentsFor(input.lineHtCents, original.vat_rate_bps)
      const note = (await client.query<CreditRow>(
      `insert into credit_notes (number, original_invoice_id, issuer_kind, issuer_driver_id, buyer_merchant_id, order_id, order_public_reference, decision_reference, decision_reason, total_ht_cents, total_vat_cents)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id, number, (select number from invoices where id = original_invoice_id) as original_invoice_number, issued_at, total_ht_cents, total_vat_cents, total_ttc_cents, transmission_status, 'prepared'::text as submission_status, null::text as last_error`,
        [number, original.invoice_id, original.issuer_kind, original.issuer_driver_id, original.buyer_merchant_id, original.order_id, original.order_public_reference, input.decisionReference, input.decisionReason, input.lineHtCents, vatCents]
      )).rows[0]
      if (note === undefined) throw new Error('Credit note insert did not return a row')
      await client.query(
        `insert into credit_note_lines (credit_note_id, line_number, original_invoice_line_id, order_id, description, vat_rate_bps, line_ht_cents, line_vat_cents)
         values ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [note.id, input.originalInvoiceLineId, original.order_id, `Avoir sur facture — Réf. #${original.order_public_reference}`, original.vat_rate_bps, input.lineHtCents, vatCents]
      )
      await this.prepareSubmission(client, { creditNoteId: note.id })
      return creditDocument(note)
    })
  }

  private async insertInvoice(client: PoolClient, order: OrderRow, buyer: LegalRow, seller: LegalRow, issuerKind: 'driver' | 'locadely', amount: number): Promise<void> {
    const issuerDriverId = issuerKind === 'driver' ? order.driver_id : locadelySequenceDriverId
    if (issuerDriverId === null) throw new InvoiceIssuanceDeferredError('driver_legal_information_incomplete')
    const number = await this.assignNumber(client, 'invoice', issuerKind, issuerDriverId, issuerKind === 'driver' ? seller.siren : null)
    const tax = vat(seller.vat_regime)
    const vatCents = vatCentsFor(amount, tax.rate)
    const invoice = (await client.query<{ id: string }>(
      `insert into invoices (number, issuer_kind, issuer_driver_id, invoice_type_code, order_id, order_public_reference, buyer_merchant_id, service_completed_at, total_ht_cents, total_vat_cents, seller_legal_name, seller_siren, seller_siret, seller_vat_number, seller_vat_regime, seller_address_line1, seller_address_line2, seller_address_postal_code, seller_address_city, seller_address_country_code, seller_electronic_address_scheme, seller_electronic_address_value, buyer_legal_name, buyer_siren, buyer_siret, buyer_vat_number, buyer_address_line1, buyer_address_line2, buyer_address_postal_code, buyer_address_city, buyer_address_country_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) returning id`,
      [number, issuerKind, issuerKind === 'driver' ? order.driver_id : null, issuerKind === 'driver' ? '389' : '380', order.id, order.public_reference, order.merchant_id, order.completed_at, amount, vatCents, seller.legal_name, seller.siren, seller.siret, seller.vat_number, seller.vat_regime, seller.address_line1, seller.address_line2, seller.address_postal_code, seller.address_city, seller.address_country_code, this.electronicAddressScheme, seller.siren, buyer.legal_name, buyer.siren, buyer.siret, buyer.vat_number, buyer.address_line1, buyer.address_line2, buyer.address_postal_code, buyer.address_city, buyer.address_country_code]
    )).rows[0]
    if (invoice === undefined) throw new Error('Invoice insert did not return a row')
    const description = issuerKind === 'driver' ? `Prestation de livraison — Réf. #${order.public_reference}` : `Frais de service Locadely — Livraison #${order.public_reference}`
    await client.query(
      `insert into invoice_lines (invoice_id, line_number, order_id, description, unit_price_ht_cents, vat_rate_bps, vat_exemption_reason_text, line_ht_cents, line_vat_cents)
       values ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
      [invoice.id, order.id, description, amount, tax.rate, tax.reason, amount, vatCents]
    )
    await this.prepareSubmission(client, { invoiceId: invoice.id })
  }

  // Tranche 1 (plan §11.G) : chaque document légal créé prépare atomiquement sa soumission
  // future — jamais après coup, jamais dépendant d'un worker séparé qui pourrait crasher entre
  // l'émission et cette ligne (§11.F.1). Aucun appel réseau ici, uniquement une ligne `prepared`.
  private async prepareSubmission(client: PoolClient, target: { invoiceId: string } | { creditNoteId: string }): Promise<void> {
    const documentId = 'invoiceId' in target ? target.invoiceId : target.creditNoteId
    await client.query(
      `insert into invoice_provider_submissions (invoice_id, credit_note_id, provider, external_id, submission_status)
       values ($1, $2, 'superpdp', $3, 'prepared')`,
      ['invoiceId' in target ? target.invoiceId : null, 'creditNoteId' in target ? target.creditNoteId : null, documentId]
    )
  }

  private async assignNumber(client: PoolClient, kind: 'invoice' | 'credit_note', issuerKind: 'driver' | 'locadely', issuerDriverId: string, sellerSiren: string | null): Promise<string> {
    const row = (await client.query<{ assign_document_number: string }>('select public.assign_document_number($1, $2, $3, $4) as assign_document_number', [kind, issuerKind, issuerDriverId, sellerSiren])).rows[0]
    if (row === undefined) throw new Error('Document number allocation failed')
    return row.assign_document_number
  }

  private async merchantLegal(client: PoolClient, merchantId: string): Promise<LegalRow | null> {
    return (await client.query<LegalRow>(`select legal_name, siren, siret, vat_number, vat_regime, legal_address_line1 as address_line1, legal_address_line2 as address_line2, legal_address_postal_code as address_postal_code, legal_address_city as address_city, legal_address_country_code as address_country_code from merchant_legal_information where merchant_id = $1`, [merchantId])).rows[0] ?? null
  }
  private async driverLegal(client: PoolClient, driverId: string): Promise<LegalRow | null> {
    return (await client.query<LegalRow>(`select professional_name as legal_name, siren, siret, vat_number, vat_regime, legal_address_line1 as address_line1, legal_address_line2 as address_line2, legal_address_postal_code as address_postal_code, legal_address_city as address_city, legal_address_country_code as address_country_code from driver_legal_information where driver_id = $1 and vat_regime is not null and (vat_regime <> 'assujetti' or nullif(btrim(vat_number), '') is not null)`, [driverId])).rows[0] ?? null
  }
  private async platformLegal(client: PoolClient): Promise<LegalRow | null> {
    return (await client.query<LegalRow>(`select legal_name, siren, siret, vat_number, vat_regime, address_line1, address_line2, address_postal_code, address_city, address_country_code from platform_legal_identity where id = true and legal_name is not null and siren is not null and siret is not null and vat_regime is not null and address_line1 is not null and address_postal_code is not null and address_city is not null and (vat_regime <> 'assujetti' or nullif(btrim(vat_number), '') is not null)`)).rows[0] ?? null
  }
  private async list(orderId: string, merchantId: string | null, driverId: string | null): Promise<OrderDocuments | null> {
    const access = merchantId === null
      ? await this.pool.query('select 1 from orders where id = $1 and driver_id = $2', [orderId, driverId])
      : await this.pool.query('select 1 from orders where id = $1 and merchant_id = $2', [orderId, merchantId])
    if (access.rowCount !== 1) return null
    const issuerClause = driverId === null ? '' : ' and issuer_driver_id = $2'
    const invoices = await this.pool.query<InvoiceRow>(`select i.id, i.number, i.issuer_kind, i.invoice_type_code, i.issued_at, i.total_ht_cents, i.total_vat_cents, i.total_ttc_cents, i.transmission_status, coalesce(s.submission_status, 'prepared') as submission_status, s.last_error from invoices i left join invoice_provider_submissions s on s.invoice_id = i.id and s.provider = 'superpdp' where i.order_id = $1${issuerClause.replaceAll('issuer_driver_id', 'i.issuer_driver_id')} order by i.issued_at asc`, driverId === null ? [orderId] : [orderId, driverId])
    const credits = await this.pool.query<CreditRow>(`select cn.id, cn.number, i.number as original_invoice_number, cn.issued_at, cn.total_ht_cents, cn.total_vat_cents, cn.total_ttc_cents, cn.transmission_status, coalesce(s.submission_status, 'prepared') as submission_status, s.last_error from credit_notes cn join invoices i on i.id = cn.original_invoice_id left join invoice_provider_submissions s on s.credit_note_id = cn.id and s.provider = 'superpdp' where cn.order_id = $1${driverId === null ? '' : ' and i.issuer_driver_id = $2'} order by cn.issued_at asc`, driverId === null ? [orderId] : [orderId, driverId])
    return { invoices: invoices.rows.map(invoiceDocument), creditNotes: credits.rows.map(creditDocument) }
  }
}

function isUniqueViolation(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505' }
