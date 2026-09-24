import { describe, expect, it } from 'vitest'
import { config } from '../../src/platform/config.js'
import { SuperPdpOAuthClient, SuperPdpEInvoiceMandateProvider, SuperPdpEInvoiceProvider, mapToEnInvoice } from '../../src/modules/invoices/public.js'

// Test d'intégration RÉEL, opt-in uniquement : jamais dans la suite normale (`npm test`), jamais
// contre autre chose qu'un compte sandbox. `docs/work/invoicing-preparation-plan.md` §10.5bis
// documente le socle déjà validé manuellement le 2026-09-23 (auth, convert, submit, events,
// Factur-X, mandat) — ce fichier le rend reproductible sans repasser par curl à la main.
// Lancer : `SUPERPDP_SANDBOX_TESTS=1 npm run test -w apps/api -- test/invoices/superpdp-sandbox.test.ts`
const enabled = process.env.SUPERPDP_SANDBOX_TESTS === '1' && config.SUPERPDP_ENABLED && config.SUPERPDP_CLIENT_ID !== undefined && config.SUPERPDP_CLIENT_SECRET !== undefined

// Minimal, valide (en-tête %PDF réel) — Super PDP rejette silencieusement tout fichier qui n'en
// est pas un, avec un message d'erreur qui ne le laisse pas deviner (voir plan §10.5bis/§10.6).
const validPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')

describe.skipIf(!enabled)('SUPER PDP sandbox (réseau réel, opt-in)', () => {
  it('acquiert un token OAuth client_credentials réel', async () => {
    const oauth = new SuperPdpOAuthClient(config.SUPERPDP_API_BASE_URL, config.SUPERPDP_CLIENT_ID as string, config.SUPERPDP_CLIENT_SECRET as string)
    const token = await oauth.accessToken()
    expect(token.length).toBeGreaterThan(10)
    // Le cache mémoire doit éviter une deuxième requête réseau tant que le token n'a pas expiré.
    await expect(oauth.accessToken()).resolves.toBe(token)
  })

  it('crée un mandat sandbox réel avec grantor_number_scheme=sandbox (Tricatel), ou confirme qu’il existe déjà au rejeu', async () => {
    const oauth = new SuperPdpOAuthClient(config.SUPERPDP_API_BASE_URL, config.SUPERPDP_CLIENT_ID as string, config.SUPERPDP_CLIENT_SECRET as string)
    const provider = new SuperPdpEInvoiceMandateProvider(config.SUPERPDP_API_BASE_URL, oauth)
    try {
      const mandate = await provider.createMandate({ grantorNumber: '000000001', grantorNumberScheme: 'sandbox', grantorLegalName: 'Tricatel', pdf: validPdf })
      expect(mandate.id.length).toBeGreaterThan(0)
      expect(['verified', 'not_verified']).toContain(mandate.verificationStatus)
      const fetched = await provider.getMandate(mandate.id)
      expect(fetched.id).toBe(mandate.id)
      const downloaded = await provider.downloadMandate(mandate.id)
      expect(downloaded.subarray(0, 4).toString()).toBe('%PDF')
    } catch (error) {
      // Le seul échec acceptable ici est "déjà existant" (rejeu du test, un mandat Burger
      // Queen→Tricatel `sandbox` existe déjà depuis un run précédent) — jamais le message
      // générique de multipart mal formé, qui indiquerait une régression du Content-Type de la
      // partie `object` (voir le commentaire du fichier `superpdp-einvoice-mandate-provider.ts`).
      expect(String(error)).not.toMatch(/must be a multipart/i)
      expect(String(error)).toMatch(/existe déjà|already exists/i)
    }
  })

  it('soumet une vraie facture via convert(to=cii)+submit et lit ses événements', async () => {
    const oauth = new SuperPdpOAuthClient(config.SUPERPDP_API_BASE_URL, config.SUPERPDP_CLIENT_ID as string, config.SUPERPDP_CLIENT_SECRET as string)
    const provider = new SuperPdpEInvoiceProvider(config.SUPERPDP_API_BASE_URL, oauth)
    const enInvoice = mapToEnInvoice({
      id: 'sandbox-test', number: `SANDBOX-${Date.now()}`, invoiceTypeCode: '380', issuedAt: new Date(), currencyCode: 'EUR',
      totalHtCents: 1000, totalVatCents: 0, totalTtcCents: 1000, buyerReference: null,
      seller: { legalName: 'Burger Queen', siren: '000000002', vatNumber: null, addressLine1: '1 rue Test', addressLine2: null, postalCode: '01000', city: 'Bourg', countryCode: 'FR', electronicAddressScheme: '0225', electronicAddressValue: '315143296_105734' },
      buyer: { legalName: 'Tricatel', siren: '000000001', vatNumber: null, addressLine1: '2 rue Test', addressLine2: null, postalCode: '01000', city: 'Bourg', countryCode: 'FR', electronicAddress: { scheme: '0225', value: '315143296_105733' } },
      paymentTermsText: 'Paiement par prélèvement SEPA automatique.', paymentMeansTypeCode: '59',
      lines: [{ lineNumber: 1, description: 'Test sandbox Claude', quantity: '1', unit: null, unitPriceHtCents: 1000, lineHtCents: 1000, lineVatCents: 0, vatRateBps: 0, vatExemptionReasonText: 'TVA non applicable, art. 293 B du CGI' }]
    }, config.SUPERPDP_ELECTRONIC_ADDRESS_SCHEME)
    const submission = await provider.submitInvoice({ externalId: `claude-test-${Date.now()}`, enInvoice })
    expect(submission.providerDocumentId.length).toBeGreaterThan(0)
    expect(submission.contentType).toBe('application/xml')
    const { events } = await provider.listEvents(0)
    expect(events.some((event) => event.invoiceId === submission.providerDocumentId)).toBe(true)
  })
})
