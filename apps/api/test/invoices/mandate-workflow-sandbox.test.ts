import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { pool } from '../../src/platform/db.js'
import { config } from '../../src/platform/config.js'
import { lockInvoiceTables } from '../support/invoice-tables-lock.js'
import { createDriversModule } from '../../src/modules/drivers/public.js'
import {
  AcceptDriverEInvoiceMandateUseCase,
  PostgresDriverEInvoiceMandateRepository,
  PostgresMandateTemplateRepository,
  PdfLibMandatePdfRenderer,
  SupabaseEInvoiceMandateStorage,
  PostgresPlatformLegalIdentityReader,
  PostgresEInvoiceMandateWorkRepository,
  RunEInvoiceMandateSubmissionsUseCase,
  PollEInvoiceMandatesUseCase,
  SuperPdpOAuthClient,
  SuperPdpEInvoiceMandateProvider
} from '../../src/modules/invoices/public.js'

// Tranche 4d (docs/work/invoicing-preparation-plan.md §15.14/§15.21) : validation RÉELLE, opt-in
// uniquement, du workflow complet mandat via le vrai code applicatif (jamais un curl isolé) —
// AcceptDriverEInvoiceMandateUseCase (vrai template V1, vrai renderer pdf-lib, vraie signature de
// test, vrai Storage) → RunEInvoiceMandateSubmissionsUseCase (vrai worker) → Super PDP sandbox
// réel → PollEInvoiceMandatesUseCase (vrai worker). Nécessite une base JETABLE (D-R) : une ligne
// `driver_einvoice_mandates` insérée ici ne peut plus jamais être supprimée (immuable). Lancer :
// `source docs/work/r47-testdb.sh reset && SUPERPDP_SANDBOX_TESTS=1 npm run test -w apps/api --
// test/invoices/mandate-workflow-sandbox.test.ts && source docs/work/r47-testdb.sh drop`
vi.setConfig({ hookTimeout: 60_000 })

const isolated = /invoice|test/.test((await pool.query<{ d: string }>('select current_database() d')).rows[0]?.d ?? '')
const sandboxReady = process.env.SUPERPDP_SANDBOX_TESTS === '1' && config.SUPERPDP_ENABLED && config.SUPERPDP_CLIENT_ID !== undefined && config.SUPERPDP_CLIENT_SECRET !== undefined
const enabled = isolated && sandboxReady

// Grantor sandbox officiel = Tricatel (`000000001`), jamais un SIREN fabriqué ni le SIREN réel
// d'un livreur : plan §7.2 confirme qu'un mandat `direction=out` identifie son grantor
// UNIQUEMENT par son SIREN, et le scénario de test officiel Super PDP autorise précisément
// Burger Queen (notre compte, grantee) à facturer au nom de Tricatel (grantor) — voir §10.5bis/
// §10.6/§15 du plan. `driver_legal_information.siret`/`.siren` sont donc volontairement ceux de
// Tricatel plutôt que des valeurs inventées : c'est la seule façon dont Super PDP en sandbox
// reconnaît un grantor existant.
const driverId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const GRANTOR_SIREN = '000000001'
const GRANTOR_SIRET = '00000000100000'

// PNG minimal valide (en-tête réel), suffisant pour exercer le chemin d'intégration signature →
// PDF → Storage → Super PDP sans dépendre d'un vrai geste de dessin (hors de portée d'un test
// backend) — la génération/l'intégration de la signature elle-même est déjà couverte par
// `pdf-lib-mandate-pdf-renderer.test.ts` (Tranche 4c).
const testSignaturePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAAAeP4ixAAAAF0lEQVR42mNk+M9QDwABygCACgBQlAAAAABJRU5ErkJggg=='

async function oauthAndProvider() {
  const oauth = new SuperPdpOAuthClient(config.SUPERPDP_API_BASE_URL, config.SUPERPDP_CLIENT_ID as string, config.SUPERPDP_CLIENT_SECRET as string)
  return { oauth, provider: new SuperPdpEInvoiceMandateProvider(config.SUPERPDP_API_BASE_URL, oauth) }
}

// LIST/DELETE ne sont des capacités d'aucun cas d'usage réel de l'application (le port
// `EInvoiceMandateProvider` n'expose que ce dont le workflow métier a besoin) — implémentées ici,
// localement au test, uniquement pour vérifier le round-trip fournisseur (§5 du brief 4d) et
// garder le compte sandbox propre entre deux exécutions (« éviter de créer beaucoup de mandats
// inutiles »), jamais pour un usage applicatif réel.
async function listSandboxMandates(oauth: SuperPdpOAuthClient): Promise<Array<{ id: number; grantor_number: string; verification_status: string }>> {
  const token = await oauth.accessToken()
  const response = await fetch(`${config.SUPERPDP_API_BASE_URL}/v1.beta/company_mandates?limit=20`, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`list company_mandates failed with HTTP ${response.status}`)
  const body = await response.json() as { data: Array<{ id: number; grantor_number: string; verification_status: string }> }
  return body.data
}
async function deleteSandboxMandate(oauth: SuperPdpOAuthClient, id: number): Promise<void> {
  const token = await oauth.accessToken()
  await fetch(`${config.SUPERPDP_API_BASE_URL}/v1.beta/company_mandates/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
}

let release: (() => Promise<void>) | undefined

beforeAll(async () => {
  if (!enabled) return
  release = await lockInvoiceTables(pool)
  await pool.query("insert into drivers(id,name,zone_id,first_name,last_name) select $1::uuid,'Sandbox Mandate Driver',id,'Amine','Kader' from zones limit 1 on conflict do nothing", [driverId])
  await pool.query(
    `insert into driver_legal_information (driver_id, professional_name, siret, siren, legal_address_line1, legal_address_postal_code, legal_address_city, legal_address_country_code)
     values ($1::uuid, 'Tricatel Sandbox Test', $2, $3, '2 rue de la Sandbox', '01000', 'Bourg-en-Bresse', 'FR')
     on conflict (driver_id) do update set professional_name = excluded.professional_name`,
    [driverId, GRANTOR_SIRET, GRANTOR_SIREN]
  )
  // `platform_legal_identity` est un singleton mutable (jamais append-only) : safe à écraser sur
  // une base JETABLE, jamais sur la base de dev/partagée (voir garde `isolated` ci-dessus).
  await pool.query(
    `update platform_legal_identity set legal_name='Locadely', siren='877508994', siret='87750899400017', vat_regime='franchise_en_base', vat_number=null,
       address_line1='5 avenue de la Sandbox', address_postal_code='01000', address_city='Bourg-en-Bresse', address_country_code='FR' where id=true`
  )
  // Compte sandbox propre : au plus un mandat par grantor côté Super PDP (constaté empiriquement).
  // Un run précédent (debug manuel §10.6) laisse déjà un mandat Tricatel — le supprimer avant de
  // lancer le vrai worker de soumission, sinon `createMandate` échoue avec "already exists" et le
  // test ne validerait rien de plus que ce que le test diagnostic existant valide déjà.
  const { oauth } = await oauthAndProvider()
  for (const mandate of await listSandboxMandates(oauth)) {
    if (mandate.grantor_number === GRANTOR_SIREN) await deleteSandboxMandate(oauth, mandate.id)
  }
})

afterAll(async () => {
  if (!enabled) return
  await pool.query('truncate table driver_einvoice_mandates')
  await pool.query('delete from driver_legal_information where driver_id=$1::uuid', [driverId])
  await pool.query('delete from drivers where id=$1::uuid', [driverId])
  await pool.query("update platform_legal_identity set legal_name=null, siren=null, siret=null, vat_regime=null, vat_number=null, address_line1=null, address_postal_code=null, address_city=null where id=true")
  await release?.()
})

describe.skipIf(!enabled)('mandate workflow — real Super PDP sandbox, via the real application code', () => {
  it('accepts a real mandate (real template/renderer/storage), submits it via the real worker, and observes a real sandbox state', async () => {
    const mandates = new PostgresDriverEInvoiceMandateRepository(pool)
    const templates = new PostgresMandateTemplateRepository(pool)
    const renderer = new PdfLibMandatePdfRenderer()
    const storage = new SupabaseEInvoiceMandateStorage(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY)
    const platformIdentity = new PostgresPlatformLegalIdentityReader(pool)
    const drivers = createDriversModule(pool)
    const legalInformation = { findDriverLegalInformation: async (id: string) => {
      const legal = await drivers.getLegalInformation(id)
      return legal === null ? null : { professionalName: legal.professionalName, siret: legal.siret, siren: legal.siren, legalAddress: legal.legalAddress, vatNumber: legal.vatNumber, vatRegime: legal.vatRegime, legalForm: legal.legalForm }
    } }
    const driverProfile = { findDriverProfile: async (id: string) => {
      const driver = await drivers.findDriverById(id)
      const firstName = driver?.firstName?.trim(); const lastName = driver?.lastName?.trim()
      return firstName === undefined || firstName === '' || lastName === undefined || lastName === '' ? null : { firstName, lastName }
    } }

    // 1) Acceptation réelle : vrai template V1, vrai renderer pdf-lib, vraie preuve d'acceptation,
    //    vrai upload Storage — AUCUN appel réseau Super PDP dans cette étape (ADR 0007).
    const accepted = await new AcceptDriverEInvoiceMandateUseCase(mandates, templates, renderer, storage, legalInformation, driverProfile, platformIdentity)
      .execute({ driverId, signatureImageBase64: testSignaturePng, signerFirstName: 'Amine', signerLastName: 'Kader' })
    expect(accepted.submissionStatus).toBe('prepared')
    expect(accepted.providerVerificationStatus).toBe('not_submitted')
    expect(accepted.snapshot.firstNameSnapshot).toBe('Amine')
    expect(accepted.snapshot.siren).toBe(GRANTOR_SIREN)

    // Le PDF réellement stocké est un vrai PDF multi-page lisible, jamais un fixture simplifié —
    // le contenu textuel exact (9 articles, placeholders substitués) est déjà vérifié
    // structurellement par `pdf-lib-mandate-pdf-renderer.test.ts` (4c) ; ici on vérifie que
        // c'est bien CE PDF-là (même chemin, même Storage réel) qui part vers Super PDP.
    const storedPdf = await storage.downloadMandatePdf(accepted.signedPdfStoragePath)
    expect(storedPdf.subarray(0, 4).toString()).toBe('%PDF')
    expect(storedPdf.length).toBeGreaterThan(2_000)

    // 2) Soumission réelle via le vrai worker (jamais createMandate() appelé directement ici).
    const workRepository = new PostgresEInvoiceMandateWorkRepository(pool)
    const { oauth, provider } = await oauthAndProvider()
    await new RunEInvoiceMandateSubmissionsUseCase(workRepository, storage, provider, { grantorNumberScheme: 'sandbox' }).execute()

    const afterSubmission = await mandates.findCurrent(driverId)
    expect(afterSubmission?.submissionStatus).toBe('submitted')
    expect(afterSubmission?.providerVerificationStatus).toBe('submitted')
    expect(afterSubmission?.lastError).toBeNull()

    const { rows: submittedRows } = await pool.query<{ provider_mandate_id: string }>('select provider_mandate_id from driver_einvoice_mandates where driver_id=$1::uuid', [driverId])
    const providerMandateId = submittedRows[0]?.provider_mandate_id
    expect(providerMandateId).toBeTruthy()

    // Rejouer le worker après succès : aucune reprise (submission_status='submitted' exclut le
    // mandat de `claimDue`) — jamais un deuxième POST, jamais un deuxième mandat côté Super PDP.
    await new RunEInvoiceMandateSubmissionsUseCase(workRepository, storage, provider, { grantorNumberScheme: 'sandbox' }).execute()
    const afterReplay = await mandates.findCurrent(driverId)
    expect(afterReplay?.submissionStatus).toBe('submitted')
    const { rows: mandatesForGrantor } = await listSandboxMandates(oauth).then((all) => ({ rows: all.filter((m) => m.grantor_number === GRANTOR_SIREN) }))
    expect(mandatesForGrantor).toHaveLength(1)

    // 3) Round-trip fournisseur réel : GET, LIST, DOWNLOAD.
    const fetched = await provider.getMandate(providerMandateId as string)
    expect(fetched.id).toBe(providerMandateId)
    expect(['not_verified', 'verified']).toContain(fetched.verificationStatus)

    const listed = await listSandboxMandates(oauth)
    expect(listed.some((m) => String(m.id) === providerMandateId)).toBe(true)

    const downloaded = await provider.downloadMandate(providerMandateId as string)
    expect(downloaded.subarray(0, 4).toString()).toBe('%PDF')
    expect(downloaded.length).toBeGreaterThan(0)
    // Super PDP peut retraiter/re-timbrer le PDF fourni (constaté possible dès la Tranche 4a/§10.6
    // pour les factures) — seule une taille dans le même ordre de grandeur est exigée ici, jamais
    // une égalité byte à byte : un changement de mise en page provider ne doit jamais faire
        // échouer ce test, seulement une divergence structurelle grossière (fichier vide/corrompu).
    expect(Math.abs(downloaded.length - storedPdf.length)).toBeLessThan(storedPdf.length)

    // 4) Polling applicatif réel — `not_verified` est un résultat VALIDE pour 4d (vérification
    //    humaine côté Super PDP, aucun SLA public, voir plan §7.2/§9.E).
    await new PollEInvoiceMandatesUseCase(workRepository, provider).execute()
    const afterPoll = await mandates.findCurrent(driverId)
    expect(['not_verified', 'verified']).toContain(afterPoll?.providerVerificationStatus)

    // Rejouer le polling : idempotent, jamais de régression d'état, jamais de crash.
    await new PollEInvoiceMandatesUseCase(workRepository, provider).execute()
    const afterSecondPoll = await mandates.findCurrent(driverId)
    expect(afterSecondPoll?.providerVerificationStatus).toBe(afterPoll?.providerVerificationStatus)
  })

  it('never blocks other mandates when the provider is unreachable for one of them (fake failure, no real network cost)', async () => {
    const workRepository = new PostgresEInvoiceMandateWorkRepository(pool)
    const failingProvider = { createMandate: async () => { throw new Error('simulated unreachable provider') }, getMandate: async () => { throw new Error('simulated unreachable provider') }, downloadMandate: async () => { throw new Error('unused') } }
    // Si le mandat du test précédent est encore `not_verified` (cas normal, la vérification est
    // manuelle côté Super PDP), il est toujours repris par `dueForVerification` : ce `getMandate`
    // qui échoue exerce alors réellement le `try/catch` de `PollEInvoiceMandatesUseCase` plutôt
    // qu'un cas vide — sans jamais faire planter l'exécution ni modifier l'état enregistré.
    await expect(new PollEInvoiceMandatesUseCase(workRepository, failingProvider as never).execute()).resolves.toBeUndefined()
  })
})
