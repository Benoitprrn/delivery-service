import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { deleteTestOrders } from '../support/cleanup-orders.js'
import { lockInvoiceTables } from '../support/invoice-tables-lock.js'
import { InvoiceIssuanceDeferredError, PostgresInvoiceRepository, PostgresInvoiceDocumentFileRepository } from '../../src/modules/invoices/public.js'
import { PostgresDriverInvoiceReadinessReader } from '../../src/modules/orders/public.js'

// Facture/avoir sont append-only par contrat (0047_invoice_engine.sql) : ce test ne peut donc
// tourner que sur une base isolée jetable (docs/work/r47-testdb.sh), jamais la base de dev
// partagée — même discipline D-R que les tests de settlements.
vi.setConfig({ hookTimeout: 60_000 })
const isolated = /invoice|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')

const merchantId = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'
const driverId = 'dddddddd-dddd-dddd-dddd-ddddddddddd1'
const otherDriverId = 'dddddddd-dddd-dddd-dddd-ddddddddddd2'
const otherMerchantId = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'
const zoneId = '11111111-1111-1111-1111-111111111111'
const orders: string[] = []
const repository = new PostgresInvoiceRepository(pool, '0225')
const documentFiles = new PostgresInvoiceDocumentFileRepository(pool)
const invoiceReadiness = new PostgresDriverInvoiceReadinessReader(pool)
let release: (() => Promise<void>) | undefined

async function createCompletedOrder(deliveryCents: number | null, serviceFeeCents: number | null, forDriverId = driverId, forMerchantId = merchantId): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `insert into orders(id,merchant_id,driver_id,zone_id,status,customer_name,customer_phone,pickup_address,pickup_lat,pickup_lng,delivery_address,delivery_lat,delivery_lng,distance_m,duration_s,driver_earning_cents,completed_at)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'COMPLETED','Client','0600000000','Pickup',46.2,5.2,'Delivery',46.21,5.21,3000,720,0,now())`,
    [id, forMerchantId, forDriverId, zoneId]
  )
  if (deliveryCents !== null) await pool.query('update orders set delivery_cents=$2, service_fee_cents=$3 where id=$1::uuid', [id, deliveryCents, serviceFeeCents])
  orders.push(id)
  return id
}

async function setPlatformLegalIdentity(complete: boolean): Promise<void> {
  if (!complete) { await pool.query("update platform_legal_identity set legal_name=null, siren=null, siret=null, vat_regime=null, address_line1=null, address_postal_code=null, address_city=null where id=true"); return }
  await pool.query(
    "update platform_legal_identity set legal_name='Locadely SAS', siren='111222333', siret='11122233300011', vat_number='FR00111222333', vat_regime='assujetti', address_line1='1 rue Locadely', address_postal_code='01000', address_city='Bourg-en-Bresse' where id=true"
  )
}

beforeAll(async () => {
  if (!isolated) return
  release = await lockInvoiceTables(pool)
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto Test',$2::uuid) on conflict do nothing", [merchantId, zoneId])
  await pool.query("insert into merchants(id,name,zone_id) values($1::uuid,'Resto Autre',$2::uuid) on conflict do nothing", [otherMerchantId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur Test',$2::uuid) on conflict do nothing", [driverId, zoneId])
  await pool.query("insert into drivers(id,name,zone_id) values($1::uuid,'Livreur Autre',$2::uuid) on conflict do nothing", [otherDriverId, zoneId])
  await pool.query("update drivers set first_name='Jean', last_name='Martin' where id=$1::uuid", [driverId])
  await pool.query(
    `insert into driver_legal_information (driver_id, professional_name, siret, siren, legal_address_line1, legal_address_postal_code, legal_address_city, vat_regime)
     values ($1::uuid,'Jean Martin Livraisons','12345678900012','123456789','1 rue du Livreur','01000','Bourg-en-Bresse','franchise_en_base') on conflict (driver_id) do nothing`,
    [driverId]
  )
  await pool.query(
    `insert into merchant_legal_information (merchant_id, siret, siren, legal_name, legal_address_line1, legal_address_postal_code, legal_address_city, sirene_verification_status)
     values ($1::uuid,'98765432100019','987654321','SAS Resto Test','2 place Test','01000','Bourg-en-Bresse','unavailable') on conflict (merchant_id) do nothing`,
    [merchantId]
  )
})

afterEach(async () => {
  if (!isolated) return
  await pool.query('truncate table credit_note_lines, credit_notes, invoice_lines, invoices, invoice_number_sequences cascade')
  await deleteTestOrders(pool, orders.splice(0))
  await setPlatformLegalIdentity(true)
})

afterAll(async () => {
  if (!isolated) return
  await pool.query('delete from driver_legal_information where driver_id = any($1::uuid[])', [[driverId, otherDriverId]])
  await pool.query('delete from merchant_legal_information where merchant_id = any($1::uuid[])', [[merchantId, otherMerchantId]])
  await pool.query('delete from drivers where id = any($1::uuid[])', [[driverId, otherDriverId]])
  await pool.query('delete from merchants where id = any($1::uuid[])', [[merchantId, otherMerchantId]])
  await release?.()
})

describe.skipIf(!isolated)('invoice engine (isolated DB only)', () => {
  it('issues exactly two invoices for a completed order, with the right amounts, VAT and numbering', async () => {
    await setPlatformLegalIdentity(true)
    const orderId = await createCompletedOrder(1000, 200)
    const result = await repository.issueForCompletedOrder(orderId)
    expect(result).toBe('issued')
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    expect(documents?.invoices).toHaveLength(2)
    const driverInvoice = documents?.invoices.find((i) => i.issuerKind === 'driver')
    const locadelyInvoice = documents?.invoices.find((i) => i.issuerKind === 'locadely')
    expect(driverInvoice).toMatchObject({ invoiceTypeCode: '389', totalHtCents: 1000, totalVatCents: 0, totalTtcCents: 1000, submissionStatus: 'prepared', lastError: null, facturXAvailable: false })
    expect(driverInvoice?.number).toMatch(/^DRV-123456789-\d{6}$/)
    expect(locadelyInvoice).toMatchObject({ invoiceTypeCode: '380', totalHtCents: 200, totalVatCents: 40, totalTtcCents: 240, submissionStatus: 'prepared', lastError: null, facturXAvailable: false })
    expect(locadelyInvoice?.number).toMatch(/^LOC-\d{6}$/)
  })

  it('is idempotent on replay: a second call is a no-op and never creates duplicates', async () => {
    const orderId = await createCompletedOrder(500, 100)
    expect(await repository.issueForCompletedOrder(orderId)).toBe('issued')
    expect(await repository.issueForCompletedOrder(orderId)).toBe('already_issued')
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    expect(documents?.invoices).toHaveLength(2)
  })

  it('skips a legacy order without frozen amounts instead of invoicing for zero', async () => {
    const orderId = await createCompletedOrder(null, null)
    expect(await repository.issueForCompletedOrder(orderId)).toBe('legacy_or_not_completed')
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    expect(documents?.invoices).toHaveLength(0)
  })

  it('defers issuance and creates nothing when the driver legal information is incomplete', async () => {
    const orderId = await createCompletedOrder(500, 100, otherDriverId)
    await expect(repository.issueForCompletedOrder(orderId)).rejects.toThrow(InvoiceIssuanceDeferredError)
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    expect(documents?.invoices).toHaveLength(0)
  })

  it('defers issuance and creates nothing when the platform legal identity is incomplete', async () => {
    await setPlatformLegalIdentity(false)
    const orderId = await createCompletedOrder(500, 100)
    await expect(repository.issueForCompletedOrder(orderId)).rejects.toThrow(InvoiceIssuanceDeferredError)
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    expect(documents?.invoices).toHaveLength(0)
  })

  it('isolates documents by tenant: wrong merchant/driver never see them, driver never sees the Locadely invoice', async () => {
    const orderId = await createCompletedOrder(700, 140)
    await repository.issueForCompletedOrder(orderId)
    expect(await repository.listForMerchantOrder(orderId, otherMerchantId)).toBeNull()
    expect(await repository.listForDriverOrder(orderId, otherDriverId)).toBeNull()
    const driverView = await repository.listForDriverOrder(orderId, driverId)
    expect(driverView?.invoices).toHaveLength(1)
    expect(driverView?.invoices[0]?.issuerKind).toBe('driver')
    expect(driverView?.invoices[0]).toMatchObject({ submissionStatus: 'prepared', lastError: null, facturXAvailable: false })
    expect(driverView?.invoices.some((invoice) => invoice.issuerKind === 'locadely')).toBe(false)
  })

  it('listForDriver: lists a driver’s own invoices across orders, most recent first, never another driver’s or Locadely’s', async () => {
    const firstOrderId = await createCompletedOrder(400, 80)
    await repository.issueForCompletedOrder(firstOrderId)
    const secondOrderId = await createCompletedOrder(600, 120)
    await repository.issueForCompletedOrder(secondOrderId)
    const otherOrderId = await createCompletedOrder(300, 60, otherDriverId)
    await pool.query("update drivers set first_name='Alice', last_name='Autre' where id=$1::uuid", [otherDriverId])
    await pool.query(
      `insert into driver_legal_information (driver_id, professional_name, siret, siren, legal_address_line1, legal_address_postal_code, legal_address_city, vat_regime)
       values ($1::uuid,'Alice Autre Livraisons','98765432100019','987654321','9 rue Autre','01000','Bourg-en-Bresse','franchise_en_base') on conflict (driver_id) do nothing`,
      [otherDriverId]
    )
    await repository.issueForCompletedOrder(otherOrderId)

    const mine = await repository.listForDriver(driverId)
    expect(mine).toHaveLength(2)
    expect(mine.every((invoice) => invoice.issuerKind === 'driver')).toBe(true)
    expect(mine[0]?.orderId).toBe(secondOrderId)
    expect(mine[1]?.orderId).toBe(firstOrderId)
    expect(mine[0]).toMatchObject({ totalHtCents: 600, merchantName: 'Resto Test' })
    expect(mine.some((invoice) => invoice.orderId === otherOrderId)).toBe(false)

    const theirs = await repository.listForDriver(otherDriverId)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.orderId).toBe(otherOrderId)

    await pool.query('delete from driver_legal_information where driver_id = $1::uuid', [otherDriverId])
  })

  it('accepts a partial credit note within the original line and rejects a cumulative overshoot', async () => {
    const orderId = await createCompletedOrder(1000, 200)
    await repository.issueForCompletedOrder(orderId)
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    const driverInvoiceId = documents?.invoices.find((i) => i.issuerKind === 'driver')?.id
    const line = await pool.query<{ id: string }>('select id from invoice_lines where invoice_id = $1::uuid', [driverInvoiceId])
    const lineId = line.rows[0]?.id
    expect(lineId).toBeDefined()
    const credit = await repository.createCreditNote({ originalInvoiceLineId: lineId as string, decisionReference: 'DEC-1', decisionReason: 'colis endommagé', lineHtCents: 600 })
    expect(credit.totalHtCents).toBe(600)
    expect(credit.originalInvoiceNumber).toMatch(/^DRV-123456789-\d{6}$/)
    await expect(repository.createCreditNote({ originalInvoiceLineId: lineId as string, decisionReference: 'DEC-2', decisionReason: 'second avoir', lineHtCents: 500 })).rejects.toThrow()
  })

  it('driver invoice readiness: complete profile passes, missing pieces fail closed', async () => {
    expect(await invoiceReadiness.isReady(driverId)).toBe(true)
    await pool.query("update drivers set first_name=null where id=$1::uuid", [driverId])
    expect(await invoiceReadiness.isReady(driverId)).toBe(false)
    await pool.query("update drivers set first_name='Jean' where id=$1::uuid", [driverId])
    await pool.query("update driver_legal_information set vat_regime='assujetti', vat_number=null where driver_id=$1::uuid", [driverId])
    expect(await invoiceReadiness.isReady(driverId)).toBe(false)
    await pool.query("update driver_legal_information set vat_regime='franchise_en_base' where driver_id=$1::uuid", [driverId])
    expect(await invoiceReadiness.isReady(driverId)).toBe(true)
  })

  it('PostgresInvoiceDocumentFileRepository: real SQL isolation for the Factur-X download endpoint', async () => {
    const orderId = await createCompletedOrder(1000, 200)
    await repository.issueForCompletedOrder(orderId)
    const documents = await repository.listForMerchantOrder(orderId, merchantId)
    const driverInvoiceId = documents?.invoices.find((i) => i.issuerKind === 'driver')?.id as string
    const locadelyInvoiceId = documents?.invoices.find((i) => i.issuerKind === 'locadely')?.id as string
    const line = await pool.query<{ id: string }>('select id from invoice_lines where invoice_id = $1::uuid', [driverInvoiceId])
    const credit = await repository.createCreditNote({ originalInvoiceLineId: line.rows[0]?.id as string, decisionReference: 'DEC-DL', decisionReason: 'test isolation', lineHtCents: 300 })

    // Le commerçant voit ses deux factures.
    expect(await documentFiles.findAuthorized({ role: 'merchant', orderId, merchantId, documentKind: 'invoice', documentId: driverInvoiceId })).not.toBeNull()
    expect(await documentFiles.findAuthorized({ role: 'merchant', orderId, merchantId, documentKind: 'invoice', documentId: locadelyInvoiceId })).not.toBeNull()
    // Mauvais commerçant/mauvaise commande : jamais trouvé.
    expect(await documentFiles.findAuthorized({ role: 'merchant', orderId, merchantId: otherMerchantId, documentKind: 'invoice', documentId: driverInvoiceId })).toBeNull()
    expect(await documentFiles.findAuthorized({ role: 'merchant', orderId: randomUUID(), merchantId, documentKind: 'invoice', documentId: driverInvoiceId })).toBeNull()
    // Le livreur voit sa propre facture...
    expect(await documentFiles.findAuthorized({ role: 'driver', orderId, driverId, documentKind: 'invoice', documentId: driverInvoiceId })).not.toBeNull()
    // ...mais jamais la facture Locadely (fuite la plus sensible de cette tranche).
    expect(await documentFiles.findAuthorized({ role: 'driver', orderId, driverId, documentKind: 'invoice', documentId: locadelyInvoiceId })).toBeNull()
    // Un autre livreur ne voit ni la facture ni l'avoir de ce livreur.
    expect(await documentFiles.findAuthorized({ role: 'driver', orderId, driverId: otherDriverId, documentKind: 'invoice', documentId: driverInvoiceId })).toBeNull()
    expect(await documentFiles.findAuthorized({ role: 'driver', orderId, driverId: otherDriverId, documentKind: 'credit_note', documentId: credit.id })).toBeNull()
    // Le livreur voit son propre avoir.
    const authorizedCredit = await documentFiles.findAuthorized({ role: 'driver', orderId, driverId, documentKind: 'credit_note', documentId: credit.id })
    expect(authorizedCredit).not.toBeNull()
    expect(authorizedCredit?.transmissionStatus).toBe('not_submitted')

    // `cacheDocument` persiste réellement le chemin/hash pour la prochaine lecture.
    const beforeCache = await documentFiles.findAuthorized({ role: 'merchant', orderId, merchantId, documentKind: 'invoice', documentId: driverInvoiceId })
    expect(beforeCache?.documentStoragePath).toBeNull()
    await documentFiles.cacheDocument({ submissionId: beforeCache?.submissionId as string, path: 'invoices/x/factur-x.pdf', contentType: 'application/pdf', sha256: 'abc' })
    const afterCache = await documentFiles.findAuthorized({ role: 'merchant', orderId, merchantId, documentKind: 'invoice', documentId: driverInvoiceId })
    expect(afterCache?.documentStoragePath).toBe('invoices/x/factur-x.pdf')
  })
})
