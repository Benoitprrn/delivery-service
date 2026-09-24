import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import multipart from '@fastify/multipart'
import { registerAccountDocumentHttpRoutes } from '../../src/modules/documents/transport/http/routes.js'
import type { Owner } from '../../src/modules/documents/application/account-documents.js'

const driverId = '33333333-3333-3333-3333-333333333333'
const otherDriverId = '44444444-4444-4444-4444-444444444444'
const merchantId = '22222222-2222-2222-2222-222222222222'
const correlationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

let app: FastifyInstance
let authUser: { id: string; role: 'merchant' | 'driver' | 'admin' }

describe('account documents — HTTP authorization and identity scoping', () => {
  beforeEach(async () => {
    app = Fastify()
    await app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024 } })
    authUser = { id: driverId, role: 'driver' }
    app.addHook('onRequest', async (request) => {
      request.correlationId = correlationId
      request.authUser = authUser
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('always derives the owner from the authenticated user, never from the URL role segment alone', async () => {
    const list = vi.fn(async (_owner: Owner) => [])
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload: vi.fn(), list, signedUrl: vi.fn(), delete: vi.fn() }
    })

    await app.inject({ method: 'GET', url: '/api/v1/drivers/me/documents' })
    expect(list).toHaveBeenCalledWith({ kind: 'driver', id: driverId })

    authUser = { id: otherDriverId, role: 'driver' }
    await app.inject({ method: 'GET', url: '/api/v1/drivers/me/documents' })
    expect(list).toHaveBeenLastCalledWith({ kind: 'driver', id: otherDriverId })
  })

  it('refuses a merchant on driver document routes and a driver on merchant document routes', async () => {
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload: vi.fn(), list: vi.fn(), signedUrl: vi.fn(), delete: vi.fn() }
    })

    authUser = { id: merchantId, role: 'merchant' }
    const asMerchantOnDriverRoute = await app.inject({ method: 'GET', url: '/api/v1/drivers/me/documents' })
    expect(asMerchantOnDriverRoute.statusCode).toBe(403)

    authUser = { id: driverId, role: 'driver' }
    const asDriverOnMerchantRoute = await app.inject({ method: 'GET', url: '/api/v1/merchants/me/documents' })
    expect(asDriverOnMerchantRoute.statusCode).toBe(403)
  })

  it('never exposes a document identifier or storage path in the list response, only type/name/date', async () => {
    const uploadedAt = new Date('2026-09-23T10:00:00.000Z')
    const list = vi.fn(async () => [{ id: 'doc-1', owner: { kind: 'driver', id: driverId } as Owner, documentType: 'identity_document' as const, storagePath: 'drivers/x/identity/doc-1.jpg', originalFilename: 'cni.jpg', contentType: 'image/jpeg' as const, sizeBytes: 123, uploadedAt }])
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload: vi.fn(), list, signedUrl: vi.fn(), delete: vi.fn() }
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me/documents' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { documents: Record<string, unknown>[] }
    expect(body.documents).toEqual([{ documentType: 'identity_document', originalFilename: 'cni.jpg', uploadedAt: uploadedAt.toISOString() }])
  })

  it('returns 404 instead of a signed URL when the requester has no current document of that type', async () => {
    const signedUrl = vi.fn(async () => null)
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload: vi.fn(), list: vi.fn(), signedUrl, delete: vi.fn() }
    })

    const response = await app.inject({ method: 'GET', url: '/api/v1/drivers/me/documents/identity_document/signed-url' })
    expect(response.statusCode).toBe(404)
    expect(signedUrl).toHaveBeenCalledWith({ kind: 'driver', id: driverId }, 'identity_document')
  })

  it('rejects an unknown document type', async () => {
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload: vi.fn(), list: vi.fn(), signedUrl: vi.fn(), delete: vi.fn() }
    })
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/drivers/me/documents/passport' })
    expect(response.statusCode).toBe(400)
  })

  it('maps a document validation failure from the use case to 400, not 500', async () => {
    // La validation réelle du contenu (signature binaire, taille) vit dans
    // UploadAccountDocumentUseCase.validateDocument — couverte par
    // test/documents/account-documents.test.ts. Ici on vérifie seulement que la route
    // traduit correctement son erreur en 400 plutôt que de la laisser remonter en 500.
    const upload = vi.fn(async () => { throw new Error('Invalid account document') })
    await app.register(registerAccountDocumentHttpRoutes, {
      documents: { upload, list: vi.fn(), signedUrl: vi.fn(), delete: vi.fn() }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/documents',
      payload: [
        '--boundary',
        'Content-Disposition: form-data; name="documentType"',
        '',
        'identity_document',
        '--boundary',
        'Content-Disposition: form-data; name="file"; filename="x.jpg"',
        'Content-Type: image/jpeg',
        '',
        'not-a-real-image',
        '--boundary--',
        ''
      ].join('\r\n'),
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' }
    })
    expect(upload).toHaveBeenCalled()
    expect(response.statusCode).toBe(400)
  })
})
