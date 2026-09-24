import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockInvoiceTables } from '../support/invoice-tables-lock.js'
import { createInvoicesModule, PostgresInvoiceRepository } from '../../src/modules/invoices/public.js'
import { PostgresEInvoiceEventsRepository, PostgresEInvoiceWorkRepository } from '../../src/modules/invoices/infrastructure/postgres-einvoice-work-repository.js'
import { PostgresEInvoiceDirectoryCacheRepository } from '../../src/modules/invoices/infrastructure/postgres-einvoice-directory-cache-repository.js'

// Tranche 1 (plan §11.G) : `invoice_provider_submissions`/`einvoice_events` sont append-only sur
// leur contenu (immutabilité) — même discipline D-R que les autres tests financiers, base isolée
// jetable uniquement (`docs/work/r47-testdb.sh`), jamais la base de dev partagée.
vi.setConfig({ hookTimeout: 60_000 })
const isolated = /invoice|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')

const merchantId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'
const driverId = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
const zoneId = '11111111-1111-1111-1111-111111111111'
const orders: string[] = []
const invoiceRepository = new PostgresInvoiceRepository(pool, '0225')
const workRepository = new PostgresEInvoiceWorkRepository(pool)
const eventsRepository = new PostgresEInvoiceEventsRepository(pool)
let release: (() => Promise<void>) | undefined

async function createCompletedOrder(deliveryCents: number, serviceFeeCents: number): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'COMPLETED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,3000,720,0,now())`,
    [id, merchantId, driverId, zoneId]
  )
  await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, deliveryCents, serviceFeeCents])
  orders.push(id)
  return id
}

// Émet une vraie commande facturée (2 factures + 2 soumissions `prepared`) et retourne les ids
// de soumission dans un ordre stable (driver d'abord).
async function issueAndGetSubmissionIds(deliveryCents = 1000, serviceFeeCents = 200): Promise<{ orderId: string; submissionIds: string[] }> {
  const orderId = await createCompletedOrder(deliveryCents, serviceFeeCents)
  await invoiceRepository.issueForCompletedOrder(orderId)
  const rows = (await pool.query<{ id: string }>(
    `select ips.id from invoice_provider_submissions ips join invoices i on i.id = ips.invoice_id where i.order_id = $1::uuid order by i.issuer_kind`, [orderId]
  )).rows
  return { orderId, submissionIds: rows.map((r) => r.id) }
}

beforeAll(async () => {
  if (!isolated) return
  release = await lockInvoiceTables(pool)
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto Events',$2::uuid) on conflict do nothing", [merchantId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur Events',$2::uuid) on conflict do nothing", [driverId, zoneId])
  await pool.query("update drivers set first_name='Jean', last_name='Events' where id=$1::uuid", [driverId])
  await pool.query(
    `insert into driver_legal_information (driver_id, professional_name, siret, siren, legal_address_line1, legal_address_postal_code, legal_address_city, vat_regime)
     values ($1::uuid,'Jean Events Livraisons','12345678900012','123456789','1 rue du Livreur','01000','Bourg-en-Bresse','franchise_en_base') on conflict (driver_id) do nothing`,
    [driverId]
  )
  await pool.query(
    `insert into merchant_legal_information (merchant_id, siret, siren, legal_name, legal_address_line1, legal_address_postal_code, legal_address_city, sirene_verification_status)
     values ($1::uuid,'98765432100019','987654321','SAS Resto Events','2 place Test','01000','Bourg-en-Bresse','unavailable') on conflict (merchant_id) do nothing`,
    [merchantId]
  )
  await pool.query(
    "update platform_legal_identity set legal_name='Locadely SAS', siren='111222333', siret='11122233300011', vat_number='FR00111222333', vat_regime='assujetti', address_line1='1 rue Locadely', address_postal_code='01000', address_city='Bourg-en-Bresse' where id=true"
  )
})

afterEach(async () => {
  if (!isolated) return
  await pool.query('truncate table einvoice_events, credit_note_lines, credit_notes, invoice_lines, invoices, invoice_number_sequences cascade')
  await pool.query("update einvoice_provider_event_cursors set last_invoice_event_id = 0, last_polled_at = null where provider = 'superpdp'")
  await pool.query('delete from merchant_einvoice_directory_cache where merchant_id = $1::uuid', [merchantId])
  await deleteTestOrders(pool, orders.splice(0))
})

afterAll(async () => {
  if (!isolated) return
  await pool.query('delete from driver_legal_information where driver_id = $1::uuid', [driverId])
  await pool.query('delete from merchant_legal_information where merchant_id = $1::uuid', [merchantId])
  await pool.query('delete from drivers where id = $1::uuid', [driverId])
  await pool.query('delete from merchants where id = $1::uuid', [merchantId])
  await release?.()
})

describe.skipIf(!isolated)('einvoice work repository (isolated DB only)', () => {
  it('issuing an order prepares exactly one submission per invoice, never a duplicate', async () => {
    const { submissionIds } = await issueAndGetSubmissionIds()
    expect(submissionIds).toHaveLength(2)
    const rows = (await pool.query<{ submission_status: string; external_id: string }>('select submission_status, external_id from invoice_provider_submissions where id = any($1::uuid[])', [submissionIds])).rows
    expect(rows.every((r) => r.submission_status === 'prepared')).toBe(true)
    expect(new Set(rows.map((r) => r.external_id)).size).toBe(2) // external_id distincts, déterministes (= id de la facture)
  })

  it('claimDue reserves the work and a second concurrent claim never gets the same row', async () => {
    await issueAndGetSubmissionIds()
    const now = new Date()
    const first = await workRepository.claimDue(now, 120, 10)
    expect(first).toHaveLength(2)
    const second = await workRepository.claimDue(now, 120, 10)
    expect(second).toHaveLength(0) // toujours sous bail, rien de plus à réclamer
  })

  it('an expired lease becomes reclaimable — no work is lost after a crash', async () => {
    await issueAndGetSubmissionIds()
    const now = new Date()
    const claimed = await workRepository.claimDue(now, 1, 10) // bail d'1 seconde, expire vite
    expect(claimed).toHaveLength(2)
    const stillLocked = await workRepository.claimDue(new Date(now.getTime() + 500), 120, 10)
    expect(stillLocked).toHaveLength(0)
    const afterExpiry = await workRepository.claimDue(new Date(now.getTime() + 2_000), 120, 10)
    expect(afterExpiry).toHaveLength(2) // repris après expiration, rien perdu
  })

  it('reconstructs the full submission work with seller/buyer/lines correctly', async () => {
    const { submissionIds } = await issueAndGetSubmissionIds(1000, 200)
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    expect(claimed).toHaveLength(2)
    const driverWork = claimed.find((w) => w.issuerKind === 'driver')
    const locadelyWork = claimed.find((w) => w.issuerKind === 'locadely')
    expect(driverWork?.invoice.invoiceTypeCode).toBe('389')
    expect(driverWork?.invoice.totalHtCents).toBe(1000)
    expect(driverWork?.invoice.lines).toHaveLength(1)
    expect(driverWork?.invoice.seller.siren).toBe('123456789')
    expect(driverWork?.invoice.buyer.siren).toBe('987654321')
    expect(driverWork?.buyerSiren).toBe('987654321')
    expect(driverWork?.buyerMerchantId).toBe(merchantId)
    expect(locadelyWork?.invoice.invoiceTypeCode).toBe('380')
    expect(locadelyWork?.invoice.totalHtCents).toBe(200)
    expect(locadelyWork?.buyerMerchantId).toBe(merchantId)
    expect(submissionIds).toEqual(expect.arrayContaining(claimed.map((w) => w.id)))
  })

  it('reconstructs a credit note submission with the original invoice buyer identity', async () => {
    const orderId = await createCompletedOrder(1000, 200)
    await invoiceRepository.issueForCompletedOrder(orderId)
    const invoiceId = (await pool.query<{ id: string }>(
      "select id from invoices where order_id = $1::uuid and issuer_kind = 'driver'", [orderId]
    )).rows[0]?.id
    const lineId = (await pool.query<{ id: string }>('select id from invoice_lines where invoice_id = $1::uuid', [invoiceId])).rows[0]?.id
    expect(lineId).toBeDefined()
    const credit = await invoiceRepository.createCreditNote({ originalInvoiceLineId: lineId as string, decisionReference: 'DEC-EVENTS-1', decisionReason: 'colis endommagé', lineHtCents: 400 })
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const creditWork = claimed.find((w) => w.documentId === credit.id)
    expect(creditWork?.documentKind).toBe('credit_note')
    expect(creditWork?.issuerKind).toBe('driver')
    expect(creditWork?.buyerSiren).toBe('987654321')
    expect(creditWork?.buyerMerchantId).toBe(merchantId)
  })

  it('exposes the merchant electronic-invoicing status from the directory cache, DB round trip', async () => {
    const { getElectronicInvoicingStatus } = createInvoicesModule(pool, '0225')
    expect(await getElectronicInvoicingStatus(merchantId)).toBe('unknown')
    const cache = new PostgresEInvoiceDirectoryCacheRepository(pool)
    await cache.upsert(merchantId, { siren: '987654321', resolution: { status: 'not_addressable' }, checkedAt: new Date() })
    expect(await getElectronicInvoicingStatus(merchantId)).toBe('unavailable')
    await cache.upsert(merchantId, { siren: '987654321', resolution: { status: 'ready', electronicAddress: { scheme: '0225', value: '987654321' } }, checkedAt: new Date() })
    expect(await getElectronicInvoicingStatus(merchantId)).toBe('available')
  })

  it('submitted/retryable/failed/unknownOutcome only transition a submission under an active lease', async () => {
    const { submissionIds } = await issueAndGetSubmissionIds()
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const id = claimed[0]?.id as string
    await workRepository.submitted({ id, providerDocumentId: '42', contentType: 'application/xml', sha256: 'abc', now: new Date() })
    const row = (await pool.query<{ submission_status: string; provider_document_id: string; locked_until: Date | null }>('select submission_status, provider_document_id, locked_until from invoice_provider_submissions where id = $1', [id])).rows[0]
    expect(row).toMatchObject({ submission_status: 'submitted', provider_document_id: '42', locked_until: null })
    // Retenter une transition sur une ligne qui n'est plus `submitting` ne fait rien silencieusement.
    await workRepository.failed({ id, error: 'should not apply', now: new Date() })
    const stillSubmitted = (await pool.query<{ submission_status: string }>('select submission_status from invoice_provider_submissions where id = $1', [id])).rows[0]
    expect(stillSubmitted?.submission_status).toBe('submitted')
    expect(submissionIds).toContain(id)
  })

  it('unknownOutcome never schedules a retry — resolved only outside the worker', async () => {
    await issueAndGetSubmissionIds()
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const id = claimed[0]?.id as string
    await workRepository.unknownOutcome({ id, error: 'timeout after send', now: new Date() })
    const row = (await pool.query<{ submission_status: string; next_attempt_at: Date | null }>('select submission_status, next_attempt_at from invoice_provider_submissions where id = $1', [id])).rows[0]
    expect(row).toMatchObject({ submission_status: 'unknown_outcome', next_attempt_at: null })
    // Un `unknown_outcome` n'est jamais repris automatiquement par `claimDue`.
    expect(await workRepository.claimDue(new Date(Date.now() + 10_000), 120, 10)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
  })

  it('events are idempotent per (provider, provider_event_id) and multiple events are all conserved', async () => {
    const { submissionIds } = await issueAndGetSubmissionIds()
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const submitted = claimed[0] as (typeof claimed)[number]
    await workRepository.submitted({ id: submitted.id, providerDocumentId: '777', contentType: 'application/xml', sha256: 'abc', now: new Date() })
    const events = [
      { id: 1, invoiceId: '777', statusCode: 'api:uploaded', statusText: 'Téléversée', createdAt: new Date('2026-09-23T10:00:00Z') },
      { id: 2, invoiceId: '777', statusCode: 'fr:200', statusText: 'Déposée', createdAt: new Date('2026-09-23T10:00:01Z') }
    ]
    await eventsRepository.applyEvents({ events, now: new Date() })
    await eventsRepository.applyEvents({ events, now: new Date() }) // rejeu, doit être un no-op
    const rows = (await pool.query<{ provider_event_id: string }>('select provider_event_id from einvoice_events order by provider_event_id')).rows
    expect(rows).toHaveLength(2)
    expect(await eventsRepository.cursor()).toBe(2)
    expect(submissionIds).toContain(submitted.id)
  })

  it('the cursor only ever advances forward, even across separate polling batches', async () => {
    const { submissionIds } = await issueAndGetSubmissionIds()
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const submitted = claimed[0] as (typeof claimed)[number]
    await workRepository.submitted({ id: submitted.id, providerDocumentId: '900', contentType: 'application/xml', sha256: 'abc', now: new Date() })
    await eventsRepository.applyEvents({ events: [{ id: 5, invoiceId: '900', statusCode: 'api:uploaded', statusText: null, createdAt: new Date() }], now: new Date() })
    expect(await eventsRepository.cursor()).toBe(5)
    await eventsRepository.applyEvents({ events: [{ id: 6, invoiceId: '900', statusCode: 'fr:200', statusText: null, createdAt: new Date() }], now: new Date() })
    expect(await eventsRepository.cursor()).toBe(6)
    expect(submissionIds).toContain(submitted.id)
  })

  it('projects all retained events cumulatively and never regresses a terminal transmission', async () => {
    const { orderId } = await issueAndGetSubmissionIds()
    const claimed = await workRepository.claimDue(new Date(), 120, 10)
    const submitted = claimed.find((item) => item.issuerKind === 'locadely') as (typeof claimed)[number]
    await workRepository.submitted({ id: submitted.id, providerDocumentId: '901', contentType: 'application/xml', sha256: 'abc', now: new Date() })
    await eventsRepository.applyEvents({ events: [
      { id: 10, invoiceId: '901', statusCode: 'api:uploaded', statusText: null, createdAt: new Date() },
      { id: 11, invoiceId: '901', statusCode: 'fr:202', statusText: null, createdAt: new Date() }
    ], now: new Date() })
    expect((await pool.query<{ submission_status: string }>('select submission_status from invoice_provider_submissions where id = $1', [submitted.id])).rows[0]?.submission_status).toBe('submitted')
    await eventsRepository.applyEvents({ events: [{ id: 12, invoiceId: '901', statusCode: 'fr:205', statusText: null, createdAt: new Date() }], now: new Date() })
    expect((await pool.query<{ submission_status: string }>('select submission_status from invoice_provider_submissions where id = $1', [submitted.id])).rows[0]?.submission_status).toBe('accepted')
    expect((await pool.query<{ transmission_status: string }>('select transmission_status from invoices where order_id = $1::uuid and issuer_kind = \'locadely\'', [orderId])).rows[0]?.transmission_status).toBe('confirmed')
    // A late intermediate/unknown event is retained but cannot pull a terminal projection backwards.
    await eventsRepository.applyEvents({ events: [{ id: 13, invoiceId: '901', statusCode: 'fr:220', statusText: null, createdAt: new Date() }], now: new Date() })
    expect((await pool.query<{ submission_status: string }>('select submission_status from invoice_provider_submissions where id = $1', [submitted.id])).rows[0]?.submission_status).toBe('accepted')
  })
})
