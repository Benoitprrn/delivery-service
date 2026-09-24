import type { Pool, PoolClient } from 'pg'
import { inTransaction } from '../../../platform/transaction.js'
import type { EInvoiceEventsRepository, EInvoiceWorkRepository, SubmissionWork } from '../ports/einvoice-work-repository.js'
import { projectSubmissionStatus, type TransmissionLine } from '../infrastructure/en16931-mapper.js'

type ClaimedRow = { id: string; invoice_id: string | null; credit_note_id: string | null; external_id: string; attempts: number }

type InvoiceDetailRow = {
  id: string; number: string; invoice_type_code: '380' | '389'; service_completed_at: Date; currency_code: string
  total_ht_cents: number; total_vat_cents: number; total_ttc_cents: number
  issuer_kind: 'driver' | 'locadely'; issuer_driver_id: string | null; buyer_merchant_id: string; buyer_siren: string
  buyer_reference: string | null
  seller_legal_name: string; seller_siren: string; seller_vat_number: string | null
  seller_address_line1: string; seller_address_line2: string | null; seller_address_postal_code: string; seller_address_city: string; seller_address_country_code: string
  seller_electronic_address_scheme: string | null; seller_electronic_address_value: string | null
  buyer_legal_name: string; buyer_vat_number: string | null
  buyer_address_line1: string; buyer_address_line2: string | null; buyer_address_postal_code: string; buyer_address_city: string; buyer_address_country_code: string
  payment_terms_text: string; payment_means_type_code: string
}
type LineRow = { line_number: number; description: string; unit_price_ht_cents: number; vat_rate_bps: number; vat_exemption_reason_text: string | null; line_ht_cents: number; line_vat_cents: number }

type CreditNoteDetailRow = InvoiceDetailRow & { credit_note_number: string; credit_note_issued_at: Date; credit_note_total_ht_cents: number; credit_note_total_vat_cents: number; credit_note_total_ttc_cents: number; original_invoice_number: string; original_invoice_issue_date: Date; original_invoice_type_code: number }
type CreditLineRow = { line_number: number; description: string; vat_rate_bps: number; line_ht_cents: number; line_vat_cents: number; original_vat_exemption_reason_text: string | null }

function lineFrom(row: LineRow): TransmissionLine {
  return { lineNumber: row.line_number, description: row.description, quantity: '1', unit: null, unitPriceHtCents: row.unit_price_ht_cents, lineHtCents: row.line_ht_cents, lineVatCents: row.line_vat_cents, vatRateBps: row.vat_rate_bps, vatExemptionReasonText: row.vat_exemption_reason_text }
}

/**
 * Tranche 1 (plan §11.G) : réservation/bail/idempotence pour le futur worker de soumission. Ne
 * owns only DB work leasing and reconstruction; directory resolution is a separate network-backed capability.
 */
export class PostgresEInvoiceWorkRepository implements EInvoiceWorkRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimDue(now: Date, leaseSeconds: number, limit: number): Promise<SubmissionWork[]> {
    const claimed = await inTransaction(this.pool, async (client) => {
      const result = await client.query<ClaimedRow>(
        `update invoice_provider_submissions
         set submission_status = 'submitting', locked_until = $2, attempts = attempts + 1, last_attempt_at = $1, updated_at = $1
         where id in (
           select id from invoice_provider_submissions
           where (
             (submission_status in ('prepared', 'retryable') and (next_attempt_at is null or next_attempt_at <= $1))
             or (submission_status = 'submitting' and locked_until < $1)
           )
           order by created_at asc, id asc
           limit $3
           for update skip locked
         )
         returning id, invoice_id, credit_note_id, external_id, attempts`,
        [now, new Date(now.getTime() + leaseSeconds * 1_000), limit]
      )
      return result.rows
    })
    const work: SubmissionWork[] = []
    for (const row of claimed) {
      const built = row.invoice_id !== null ? await this.buildInvoiceWork(row) : await this.buildCreditNoteWork(row)
      if (built !== null) work.push(built)
    }
    return work
  }

  public async submitted(input: { id: string; providerDocumentId: string; contentType: string; sha256: string; now: Date }): Promise<void> {
    await this.pool.query(
      `update invoice_provider_submissions
       set submission_status = 'submitted', provider_document_id = $2, document_content_type = $3, document_sha256 = $4,
           locked_until = null, next_attempt_at = null, last_error = null, updated_at = $5
       where id = $1 and submission_status = 'submitting'`,
      [input.id, input.providerDocumentId, input.contentType, input.sha256, input.now]
    )
  }

  public async retryable(input: { id: string; error: string; retryAt: Date; now: Date }): Promise<void> {
    await this.pool.query(
      `update invoice_provider_submissions
       set submission_status = 'retryable', last_error = $2, next_attempt_at = $3, locked_until = null, updated_at = $4
       where id = $1 and submission_status = 'submitting'`,
      [input.id, input.error, input.retryAt, input.now]
    )
  }

  public async failed(input: { id: string; error: string; now: Date }): Promise<void> {
    await this.pool.query(
      `update invoice_provider_submissions
       set submission_status = 'failed', last_error = $2, locked_until = null, next_attempt_at = null, updated_at = $3
       where id = $1 and submission_status = 'submitting'`,
      [input.id, input.error, input.now]
    )
  }

  public async unknownOutcome(input: { id: string; error: string; now: Date }): Promise<void> {
    // Jamais de `next_attempt_at` posé ici : un résultat ambigu ne se retente jamais seul
    // (ADR 0007 §5) — la ligne reste `unknown_outcome` jusqu'à une résolution explicite (hors
    // worker), le bail est simplement libéré pour ne pas fausser un futur diagnostic.
    await this.pool.query(
      `update invoice_provider_submissions
       set submission_status = 'unknown_outcome', last_error = $2, locked_until = null, updated_at = $3
       where id = $1 and submission_status = 'submitting'`,
      [input.id, input.error, input.now]
    )
  }

  private async buildInvoiceWork(row: ClaimedRow): Promise<SubmissionWork | null> {
    if (row.invoice_id === null) return null
    const invoice = (await this.pool.query<InvoiceDetailRow>(
      `select id, number, invoice_type_code, service_completed_at, currency_code, total_ht_cents, total_vat_cents, total_ttc_cents,
              issuer_kind, issuer_driver_id, buyer_merchant_id, buyer_siren,
              seller_legal_name, seller_siren, seller_vat_number, seller_address_line1, seller_address_line2, seller_address_postal_code, seller_address_city, seller_address_country_code,
              seller_electronic_address_scheme, seller_electronic_address_value,
              buyer_legal_name, buyer_vat_number, buyer_address_line1, buyer_address_line2, buyer_address_postal_code, buyer_address_city, buyer_address_country_code,
              payment_terms_text, payment_means_type_code, mli.buyer_reference
       from invoices left join merchant_legal_information mli on mli.merchant_id = invoices.buyer_merchant_id where invoices.id = $1`, [row.invoice_id]
    )).rows[0]
    if (invoice === undefined) return null
    const lines = (await this.pool.query<LineRow>(
      `select line_number, description, unit_price_ht_cents, vat_rate_bps, vat_exemption_reason_text, line_ht_cents, line_vat_cents
       from invoice_lines where invoice_id = $1 order by line_number asc`, [row.invoice_id]
    )).rows
    return {
      id: row.id, documentKind: 'invoice', documentId: row.invoice_id, externalId: row.external_id, attempts: row.attempts,
      issuerKind: invoice.issuer_kind, issuerDriverId: invoice.issuer_driver_id, buyerMerchantId: invoice.buyer_merchant_id, buyerSiren: invoice.buyer_siren,
      invoice: {
        id: invoice.id, number: invoice.number, invoiceTypeCode: invoice.invoice_type_code, issuedAt: invoice.service_completed_at, currencyCode: invoice.currency_code, buyerReference: invoice.buyer_reference,
        totalHtCents: invoice.total_ht_cents, totalVatCents: invoice.total_vat_cents, totalTtcCents: invoice.total_ttc_cents,
        seller: {
          legalName: invoice.seller_legal_name, siren: invoice.seller_siren, vatNumber: invoice.seller_vat_number,
          addressLine1: invoice.seller_address_line1, addressLine2: invoice.seller_address_line2, postalCode: invoice.seller_address_postal_code, city: invoice.seller_address_city, countryCode: invoice.seller_address_country_code,
          electronicAddressScheme: invoice.seller_electronic_address_scheme, electronicAddressValue: invoice.seller_electronic_address_value
        },
        buyer: {
          legalName: invoice.buyer_legal_name, siren: invoice.buyer_siren, vatNumber: invoice.buyer_vat_number,
          addressLine1: invoice.buyer_address_line1, addressLine2: invoice.buyer_address_line2, postalCode: invoice.buyer_address_postal_code, city: invoice.buyer_address_city, countryCode: invoice.buyer_address_country_code
        },
        paymentTermsText: invoice.payment_terms_text, paymentMeansTypeCode: invoice.payment_means_type_code,
        lines: lines.map(lineFrom)
      }
    }
  }

  private async buildCreditNoteWork(row: ClaimedRow): Promise<SubmissionWork | null> {
    if (row.credit_note_id === null) return null
    const credit = (await this.pool.query<CreditNoteDetailRow>(
      `select cn.number as credit_note_number, cn.issued_at as credit_note_issued_at, cn.total_ht_cents as credit_note_total_ht_cents,
              cn.total_vat_cents as credit_note_total_vat_cents, cn.total_ttc_cents as credit_note_total_ttc_cents,
              cn.issuer_kind, cn.issuer_driver_id,
              i.id, i.number as original_invoice_number, i.issue_date as original_invoice_issue_date, i.invoice_type_code::int as original_invoice_type_code,
              i.currency_code, i.buyer_merchant_id, i.buyer_siren,
              i.seller_legal_name, i.seller_siren, i.seller_vat_number, i.seller_address_line1, i.seller_address_line2, i.seller_address_postal_code, i.seller_address_city, i.seller_address_country_code,
              i.seller_electronic_address_scheme, i.seller_electronic_address_value,
              i.buyer_legal_name, i.buyer_vat_number, i.buyer_address_line1, i.buyer_address_line2, i.buyer_address_postal_code, i.buyer_address_city, i.buyer_address_country_code,
              i.payment_terms_text, i.payment_means_type_code, mli.buyer_reference
       from credit_notes cn join invoices i on i.id = cn.original_invoice_id left join merchant_legal_information mli on mli.merchant_id = i.buyer_merchant_id where cn.id = $1`, [row.credit_note_id]
    )).rows[0]
    if (credit === undefined) return null
    const lines = (await this.pool.query<CreditLineRow>(
      `select cnl.line_number, cnl.description, cnl.vat_rate_bps, cnl.line_ht_cents, cnl.line_vat_cents, il.vat_exemption_reason_text as original_vat_exemption_reason_text
       from credit_note_lines cnl join invoice_lines il on il.id = cnl.original_invoice_line_id
       where cnl.credit_note_id = $1 order by cnl.line_number asc`, [row.credit_note_id]
    )).rows
    return {
      id: row.id, documentKind: 'credit_note', documentId: row.credit_note_id, externalId: row.external_id, attempts: row.attempts,
      issuerKind: credit.issuer_kind, issuerDriverId: credit.issuer_driver_id, buyerMerchantId: credit.buyer_merchant_id, buyerSiren: credit.buyer_siren,
      invoice: {
        id: credit.id, number: credit.credit_note_number, invoiceTypeCode: credit.issuer_kind === 'driver' ? '389' : '380', issuedAt: credit.credit_note_issued_at, currencyCode: credit.currency_code, buyerReference: credit.buyer_reference,
        totalHtCents: credit.credit_note_total_ht_cents, totalVatCents: credit.credit_note_total_vat_cents, totalTtcCents: credit.credit_note_total_ttc_cents,
        seller: {
          legalName: credit.seller_legal_name, siren: credit.seller_siren, vatNumber: credit.seller_vat_number,
          addressLine1: credit.seller_address_line1, addressLine2: credit.seller_address_line2, postalCode: credit.seller_address_postal_code, city: credit.seller_address_city, countryCode: credit.seller_address_country_code,
          electronicAddressScheme: credit.seller_electronic_address_scheme, electronicAddressValue: credit.seller_electronic_address_value
        },
        buyer: {
          legalName: credit.buyer_legal_name, siren: credit.buyer_siren, vatNumber: credit.buyer_vat_number,
          addressLine1: credit.buyer_address_line1, addressLine2: credit.buyer_address_line2, postalCode: credit.buyer_address_postal_code, city: credit.buyer_address_city, countryCode: credit.buyer_address_country_code
        },
        paymentTermsText: credit.payment_terms_text, paymentMeansTypeCode: credit.payment_means_type_code,
        lines: lines.map((l) => ({ lineNumber: l.line_number, description: l.description, quantity: '1', unit: null, unitPriceHtCents: l.line_ht_cents, lineHtCents: l.line_ht_cents, lineVatCents: l.line_vat_cents, vatRateBps: l.vat_rate_bps, vatExemptionReasonText: l.original_vat_exemption_reason_text })),
        precedingInvoice: { number: credit.original_invoice_number, issueDate: credit.original_invoice_issue_date, typeCode: credit.original_invoice_type_code }
      }
    }
  }
}

export class PostgresEInvoiceEventsRepository implements EInvoiceEventsRepository {
  public constructor(private readonly pool: Pool, private readonly provider: string = 'superpdp') {}

  public async cursor(): Promise<number> {
    const row = (await this.pool.query<{ last_invoice_event_id: string }>(
      'select last_invoice_event_id from einvoice_provider_event_cursors where provider = $1', [this.provider]
    )).rows[0]
    return row === undefined ? 0 : Number(row.last_invoice_event_id)
  }

  public async applyEvents(input: { events: Array<{ id: number; invoiceId: string; statusCode: string; statusText: string | null; createdAt: Date }>; now: Date }): Promise<void> {
    if (input.events.length === 0) return
    await inTransaction(this.pool, async (client) => {
      for (const event of input.events) {
        await this.insertEvent(client, event)
      }
      const submissionIds = await client.query<{ submission_id: string }>(
        `select distinct submission_id from einvoice_events
         where provider = $1 and provider_document_id = any($2::text[])`,
        [this.provider, input.events.map((event) => event.invoiceId)]
      )
      for (const { submission_id: submissionId } of submissionIds.rows) {
        await this.applyProjectedStatus(client, submissionId, input.now)
      }
      const maxId = Math.max(...input.events.map((event) => event.id))
      await client.query(
        `update einvoice_provider_event_cursors set last_invoice_event_id = greatest(last_invoice_event_id, $2), last_polled_at = $3, updated_at = $3 where provider = $1`,
        [this.provider, maxId, input.now]
      )
    })
  }

  private async insertEvent(client: PoolClient, event: { id: number; invoiceId: string; statusCode: string; statusText: string | null; createdAt: Date }): Promise<void> {
    const submission = (await client.query<{ id: string }>(
      `select id from invoice_provider_submissions where provider = $1 and provider_document_id = $2`, [this.provider, event.invoiceId]
    )).rows[0]
    if (submission === undefined) return // événement pour une soumission inconnue localement — ignoré, jamais bloquant.
    await client.query(
      `insert into einvoice_events (provider, submission_id, provider_event_id, provider_document_id, status_code, status_text, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (provider, provider_event_id) do nothing`,
      [this.provider, submission.id, event.id, event.invoiceId, event.statusCode, event.statusText, event.createdAt]
    )
  }

  /**
   * The sole writer of provider and UI transmission projections; it only PROMOTES a submission
   * from `submitted` to a terminal state (`accepted`/`rejected`) — never the reverse, and never
   * from one terminal state to the other. Un état terminal déjà atteint est figé pour de bon,
   * même si un événement en désordre ou une correction arrive après (plan §11.G/ADR 0007 §6) :
   * un événement conflictuel après coup est conservé tel quel dans `einvoice_events` pour l'audit,
   * jamais silencieusement traduit en un changement de statut de transmission.
   */
  private async applyProjectedStatus(client: PoolClient, submissionId: string, now: Date): Promise<void> {
    const submission = (await client.query<{ submission_status: string; invoice_id: string | null; credit_note_id: string | null }>(
      `select submission_status, invoice_id, credit_note_id from invoice_provider_submissions where id = $1 for update`, [submissionId]
    )).rows[0]
    if (submission === undefined || submission.submission_status !== 'submitted') return
    const codes = (await client.query<{ status_code: string }>(
      'select status_code from einvoice_events where provider = $1 and submission_id = $2', [this.provider, submissionId]
    )).rows.map((row) => row.status_code)
    const projected = projectSubmissionStatus(codes)
    if (projected === 'submitted') return
    const updated = await client.query(
      `update invoice_provider_submissions set submission_status = $2, updated_at = $3
       where id = $1 and submission_status = 'submitted'`,
      [submissionId, projected, now]
    )
    if (updated.rowCount === 0) return
    const transmissionStatus = projected === 'accepted' ? 'confirmed' : 'rejected'
    if (submission.invoice_id !== null) {
      await client.query('update invoices set transmission_status = $2 where id = $1', [submission.invoice_id, transmissionStatus])
    } else if (submission.credit_note_id !== null) {
      await client.query('update credit_notes set transmission_status = $2 where id = $1', [submission.credit_note_id, transmissionStatus])
    }
  }
}
