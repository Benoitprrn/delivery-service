'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AddressAutocomplete, type AddressSuggestion } from '@/components/address-autocomplete'
import { useToast } from '@/components/toast-provider'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/config'
import { cn } from '@/lib/utils'
import { CardPayments } from '@/components/card-payments'
import { SepaPaymentMethod } from '@/components/sepa-payment-method'

const FRENCH_PHONE_REGEX = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/
const PASSWORD_MIN_LENGTH = 8
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024

type MerchantAccount = {
  name: string
  phonePrimary: string | null
  phoneSecondary: string | null
  logoUrl: string | null
  address: string | null
  lat: number | null
  lng: number | null
}

type GeoPoint = { lat: number; lng: number }

type PostalAddress = {
  line1: string
  line2: string | null
  postalCode: string
  city: string
  countryCode: string
  communeCode: string | null
}

type VatRegime = 'assujetti' | 'franchise_en_base' | 'exonere'

const VAT_REGIME_OPTIONS: { value: VatRegime; label: string }[] = [
  { value: 'assujetti', label: 'Assujetti à la TVA' },
  { value: 'franchise_en_base', label: 'Franchise en base' },
  { value: 'exonere', label: 'Exonéré' }
]

function isVatRegime(value: unknown): value is VatRegime | null {
  return value === null || value === 'assujetti' || value === 'franchise_en_base' || value === 'exonere'
}

type MerchantLegalInformation = {
  siret: string
  siren: string
  legalName: string
  legalAddress: PostalAddress
  billingAddress: PostalAddress | null
  vatNumber: string | null
  vatRegime: VatRegime | null
  legalForm: string | null
  buyerReference: string | null
  sireneVerificationStatus: string
  sireneVerifiedAt: string | null
}

type LegalInformationDraft = {
  siret: string
  legalName: string
  legalAddress: PostalAddress
  billingAddress: PostalAddress
  billingAddressDifferent: boolean
  vatNumber: string
  vatRegime: VatRegime | ''
  legalForm: string
  buyerReference: string
  sireneVerificationStatus: string
  sireneWarning: string | null
}

// Statut technique de transmission (annuaire Super PDP), jamais une donnée légale : dérivé
// serveur, affiché sans jargon (voir docs/work/invoicing-preparation-plan.md §13/Tranche 3).
type ElectronicInvoicingStatus = 'available' | 'unavailable' | 'unknown'

function isElectronicInvoicingStatus(value: unknown): value is ElectronicInvoicingStatus {
  return value === 'available' || value === 'unavailable' || value === 'unknown'
}

function electronicInvoicingStatusInfo(status: ElectronicInvoicingStatus): { label: string; className: string } | null {
  switch (status) {
    case 'available':
      return { label: 'Facturation électronique disponible', className: 'bg-primary-100 text-primary-800' }
    case 'unavailable':
      return { label: "Votre entreprise n'est pas encore adressable pour la facturation électronique.", className: 'bg-stone-100 text-stone-600' }
    default:
      return null
  }
}

type AccountContact = { firstName: string; lastName: string; phone: string }

function parseAccountContact(value: unknown): AccountContact | null {
  if (!isRecord(value) || typeof value.firstName !== 'string' || typeof value.lastName !== 'string' || typeof value.phone !== 'string') return null
  return { firstName: value.firstName, lastName: value.lastName, phone: value.phone }
}

type AccountDocumentType = 'identity_document' | 'business_registration_document'

type AccountDocument = { documentType: AccountDocumentType; originalFilename: string | null; uploadedAt: string }

function parseAccountDocuments(value: unknown): AccountDocument[] | null {
  if (!isRecord(value) || !Array.isArray(value.documents)) return null
  const documents: AccountDocument[] = []
  for (const item of value.documents) {
    if (
      !isRecord(item) ||
      (item.documentType !== 'identity_document' && item.documentType !== 'business_registration_document') ||
      !isNullableString(item.originalFilename) ||
      typeof item.uploadedAt !== 'string'
    ) {
      return null
    }
    documents.push({ documentType: item.documentType, originalFilename: item.originalFilename, uploadedAt: item.uploadedAt })
  }
  return documents
}

const DOCUMENT_LABELS: Record<AccountDocumentType, { title: string; hint: string }> = {
  identity_document: { title: "Pièce d'identité du responsable", hint: 'PDF, JPEG ou PNG, 10 Mo maximum' },
  business_registration_document: { title: 'Justificatif d’entreprise', hint: 'Kbis, extrait RCS/K, attestation SIRENE… — PDF, JPEG ou PNG, 10 Mo maximum' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === 'number' || value === null
}

function parsePostalAddress(value: unknown): PostalAddress | null {
  if (
    !isRecord(value) ||
    typeof value.line1 !== 'string' ||
    !isNullableString(value.line2) ||
    typeof value.postalCode !== 'string' ||
    typeof value.city !== 'string' ||
    typeof value.countryCode !== 'string' ||
    !isNullableString(value.communeCode)
  ) {
    return null
  }

  return {
    line1: value.line1,
    line2: value.line2,
    postalCode: value.postalCode,
    city: value.city,
    countryCode: value.countryCode,
    communeCode: value.communeCode
  }
}

function emptyPostalAddress(): PostalAddress {
  return { line1: '', line2: null, postalCode: '', city: '', countryCode: 'FR', communeCode: null }
}

function clonePostalAddress(address: PostalAddress): PostalAddress {
  return { ...address }
}

function normalizeSiret(value: string): string {
  return value.replace(/[\s.-]/g, '')
}

function isValidSiret(value: string): boolean {
  return /^\d{14}$/.test(normalizeSiret(value))
}

function addressIsComplete(address: PostalAddress): boolean {
  return address.line1.trim().length > 0 && address.postalCode.trim().length > 0 && address.city.trim().length > 0 && address.countryCode.trim().length === 2
}

function parseMerchantLegalInformation(value: unknown): MerchantLegalInformation | null {
  if (!isRecord(value)) return null
  const legalAddress = parsePostalAddress(value.legalAddress)
  const billingAddress = value.billingAddress === null ? null : parsePostalAddress(value.billingAddress)
  if (
    typeof value.siret !== 'string' ||
    typeof value.siren !== 'string' ||
    typeof value.legalName !== 'string' ||
    legalAddress === null ||
    billingAddress === undefined ||
    !isNullableString(value.vatNumber) ||
    !isVatRegime(value.vatRegime) ||
    !isNullableString(value.legalForm) ||
    !isNullableString(value.buyerReference) ||
    typeof value.sireneVerificationStatus !== 'string' ||
    !isNullableString(value.sireneVerifiedAt)
  ) {
    return null
  }

  return {
    siret: value.siret,
    siren: value.siren,
    legalName: value.legalName,
    legalAddress,
    billingAddress,
    vatNumber: value.vatNumber,
    vatRegime: value.vatRegime,
    legalForm: value.legalForm,
    buyerReference: value.buyerReference,
    sireneVerificationStatus: value.sireneVerificationStatus,
    sireneVerifiedAt: value.sireneVerifiedAt
  }
}

type LegalInformationResponse = { legalInformation: MerchantLegalInformation | null; merchantLegalInformationCompleted: boolean; electronicInvoicingStatus: ElectronicInvoicingStatus }

function parseLegalInformationResponse(body: unknown): LegalInformationResponse | null {
  if (!isRecord(body) || typeof body.merchantLegalInformationCompleted !== 'boolean' || !isElectronicInvoicingStatus(body.electronicInvoicingStatus)) return null
  if (body.legalInformation === null) return { legalInformation: null, merchantLegalInformationCompleted: false, electronicInvoicingStatus: body.electronicInvoicingStatus }
  const legalInformation = parseMerchantLegalInformation(body.legalInformation)
  if (legalInformation === null) return null
  return { legalInformation, merchantLegalInformationCompleted: body.merchantLegalInformationCompleted, electronicInvoicingStatus: body.electronicInvoicingStatus }
}

function toLegalInformationDraft(value: MerchantLegalInformation): LegalInformationDraft {
  return {
    siret: value.siret,
    legalName: value.legalName,
    legalAddress: clonePostalAddress(value.legalAddress),
    billingAddress: value.billingAddress === null ? emptyPostalAddress() : clonePostalAddress(value.billingAddress),
    billingAddressDifferent: value.billingAddress !== null,
    vatNumber: value.vatNumber ?? '',
    vatRegime: value.vatRegime ?? '',
    legalForm: value.legalForm ?? '',
    buyerReference: value.buyerReference ?? '',
    sireneVerificationStatus: value.sireneVerificationStatus,
    sireneWarning: null
  }
}

type SireneLookupResult = {
  siret: string
  siren: string
  legalName: string | null
  legalAddress: PostalAddress | null
  sireneVerificationStatus: string
  warning: string | null
}

function parseSireneLookupResult(body: unknown): SireneLookupResult | null {
  if (!isRecord(body) || typeof body.siret !== 'string' || typeof body.siren !== 'string' || !isNullableString(body.legalName) || !isNullableString(body.warning) || typeof body.sireneVerificationStatus !== 'string') {
    return null
  }
  const legalAddress = body.legalAddress === null ? null : parsePostalAddress(body.legalAddress)
  if (legalAddress === undefined) return null

  return {
    siret: body.siret,
    siren: body.siren,
    legalName: body.legalName,
    legalAddress,
    sireneVerificationStatus: body.sireneVerificationStatus,
    warning: body.warning
  }
}

// address/lat/lng sont nullable : un commerçant dont l'onboarding n'est pas
// terminé n'a pas encore ces informations — cette page reste malgré tout la
// façon dont il les renseigne (finalisation de "Mon Compte").
function parseMerchantAccount(body: unknown): MerchantAccount | null {
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    !isNullableString(body.phonePrimary) ||
    !isNullableString(body.phoneSecondary) ||
    !isNullableString(body.logoUrl) ||
    !isNullableString(body.address) ||
    !isNullableNumber(body.lat) ||
    !isNullableNumber(body.lng)
  ) {
    return null
  }

  return {
    name: body.name,
    phonePrimary: body.phonePrimary,
    phoneSecondary: body.phoneSecondary,
    logoUrl: body.logoUrl,
    address: body.address,
    lat: body.lat,
    lng: body.lng
  }
}

function nullablePhone(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function saveErrorMessage(errorCode: string | undefined, serverMessage: string | undefined): string {
  switch (errorCode) {
    case 'AddressNotFoundError':
      return "Cette adresse n'a pas été reconnue. Vérifiez-la et réessayez."
    case 'AddressOutsideZoneError':
      return "Cette adresse est en dehors de la zone de livraison Locadely."
    case 'AmbiguousMerchantZoneError':
      return "Cette adresse correspond à plusieurs zones Locadely. Contactez le support."
    case 'ValidationError':
      return 'Vérifiez les informations saisies.'
    default:
      return serverMessage ?? "L'enregistrement a échoué."
  }
}

function legalInformationErrorMessage(errorCode: string | undefined, serverMessage: string | undefined): string {
  switch (errorCode) {
    case 'InvalidSiretError':
      return 'Saisissez un SIRET valide à 14 chiffres.'
    case 'SiretNotFoundError':
      return "Ce SIRET n'existe pas dans le répertoire Sirene."
    case 'SireneUnavailableError':
    case 'SireneProviderResponseError':
      return 'La recherche Sirene est momentanément indisponible. Vous pouvez compléter les informations manuellement.'
    case 'SireneRestrictedError':
      return 'Les données de ce SIRET ne sont pas accessibles. Vous pouvez compléter les informations manuellement.'
    case 'ValidationError':
      return 'Vérifiez les informations légales saisies.'
    default:
      return serverMessage ?? "L'enregistrement des informations légales a échoué."
  }
}

function sireneStatusLabel(status: string): { label: string; className: string } {
  switch (status) {
    case 'verified':
      return { label: 'Vérifié via Sirene', className: 'bg-primary-100 text-primary-800' }
    case 'unavailable':
      return { label: 'Vérification indisponible', className: 'bg-accent-100 text-accent-800' }
    case 'restricted':
      return { label: 'Données Sirene non accessibles', className: 'bg-accent-100 text-accent-800' }
    case 'unverified':
      return { label: 'Non vérifié', className: 'bg-stone-100 text-stone-600' }
    default:
      return { label: 'Statut Sirene inconnu', className: 'bg-stone-100 text-stone-600' }
  }
}

function merchantInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()

  return initials || '??'
}

export default function AccountPage() {
  const { showToast } = useToast()
  const logoInputRef = useRef<HTMLInputElement>(null)

  const [loadStatus, setLoadStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [email, setEmail] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  const [isChangingEmail, setIsChangingEmail] = useState(false)

  const [name, setName] = useState('')
  const [phonePrimary, setPhonePrimary] = useState('')
  const [phoneSecondary, setPhoneSecondary] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [geocoded, setGeocoded] = useState<GeoPoint | undefined>(undefined)
  const [original, setOriginal] = useState<MerchantAccount | undefined>(undefined)
  const [phonePrimaryTouched, setPhonePrimaryTouched] = useState(false)
  const [phoneSecondaryTouched, setPhoneSecondaryTouched] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploadingLogo, setIsUploadingLogo] = useState(false)

  const [legalLoadStatus, setLegalLoadStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [legalOriginal, setLegalOriginal] = useState<MerchantLegalInformation | undefined>(undefined)
  const [electronicInvoicingStatus, setElectronicInvoicingStatus] = useState<ElectronicInvoicingStatus>('unknown')
  const [legalDraft, setLegalDraft] = useState<LegalInformationDraft>({
    siret: '',
    legalName: '',
    legalAddress: emptyPostalAddress(),
    billingAddress: emptyPostalAddress(),
    billingAddressDifferent: false,
    vatNumber: '',
    vatRegime: '',
    legalForm: '',
    buyerReference: '',
    sireneVerificationStatus: 'unverified',
    sireneWarning: null
  })
  const [isLookingUpSiret, setIsLookingUpSiret] = useState(false)
  const [isSavingLegalInformation, setIsSavingLegalInformation] = useState(false)
  const [legalTouched, setLegalTouched] = useState(false)
  const [legalSaveAttempted, setLegalSaveAttempted] = useState(false)

  const [contactLoadStatus, setContactLoadStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [contactFirstName, setContactFirstName] = useState('')
  const [contactLastName, setContactLastName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactOriginal, setContactOriginal] = useState<AccountContact | undefined>(undefined)
  const [isSavingContact, setIsSavingContact] = useState(false)

  const [documentsLoadStatus, setDocumentsLoadStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [documents, setDocuments] = useState<AccountDocument[]>([])
  const [documentBusy, setDocumentBusy] = useState<AccountDocumentType | null>(null)
  const identityFileInputRef = useRef<HTMLInputElement>(null)
  const businessDocFileInputRef = useRef<HTMLInputElement>(null)

  const [newPassword, setNewPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  const loadAccount = useCallback(async (): Promise<void> => {
    const supabase = createSupabaseBrowserClient()
    const {
      data: { session }
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (session === null || token === undefined) {
      throw new Error('Session expirée, reconnectez-vous.')
    }

    const currentEmail = session.user.email ?? ''
    setEmail(currentEmail)
    setEmailDraft(currentEmail)

    const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    const parsed = parseMerchantAccount(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger les informations du commerce.')
    }

    setName(parsed.name)
    setPhonePrimary(parsed.phonePrimary ?? '')
    setPhoneSecondary(parsed.phoneSecondary ?? '')
    setLogoUrl(parsed.logoUrl)
    setAddress(parsed.address ?? '')
    setGeocoded(parsed.lat !== null && parsed.lng !== null ? { lat: parsed.lat, lng: parsed.lng } : undefined)
    setOriginal(parsed)
  }, [])

  const loadLegalInformation = useCallback(async (): Promise<void> => {
    const token = await getAccessToken()
    const response = await fetch(`${apiUrl}/api/v1/merchants/me/legal-information`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    const parsed = parseLegalInformationResponse(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger les informations légales.')
    }

    setElectronicInvoicingStatus(parsed.electronicInvoicingStatus)
    if (parsed.legalInformation === null) {
      setLegalOriginal(undefined)
      return
    }
    setLegalOriginal(parsed.legalInformation)
    setLegalDraft(toLegalInformationDraft(parsed.legalInformation))
  }, [])

  const loadAccountContact = useCallback(async (): Promise<void> => {
    const token = await getAccessToken()
    const response = await fetch(`${apiUrl}/api/v1/merchants/me/account-contact`, {
      headers: { authorization: `Bearer ${token}` }
    })
    if (response.status === 404) {
      setContactOriginal(undefined)
      return
    }
    const body: unknown = await response.json()
    const parsed = parseAccountContact(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger le responsable du compte.')
    }
    setContactOriginal(parsed)
    setContactFirstName(parsed.firstName)
    setContactLastName(parsed.lastName)
    setContactPhone(parsed.phone)
  }, [])

  const loadDocuments = useCallback(async (): Promise<void> => {
    const token = await getAccessToken()
    const response = await fetch(`${apiUrl}/api/v1/merchants/me/documents`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    const parsed = parseAccountDocuments(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger les documents.')
    }
    setDocuments(parsed)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialLoad() {
      try {
        await loadAccount()
        if (!cancelled) setLoadStatus('success')
      } catch (error) {
        if (!cancelled) {
          setLoadStatus('error')
          showToast({
            variant: 'error',
            title: 'Erreur',
            message: error instanceof Error ? error.message : 'Impossible de charger les informations du commerce.'
          })
        }
      }

      try {
        await loadLegalInformation()
        if (!cancelled) setLegalLoadStatus('success')
      } catch (error) {
        if (!cancelled) {
          setLegalLoadStatus('error')
          showToast({
            variant: 'error',
            title: 'Erreur',
            message: error instanceof Error ? error.message : 'Impossible de charger les informations légales.'
          })
        }
      }

      try {
        await loadAccountContact()
        if (!cancelled) setContactLoadStatus('success')
      } catch (error) {
        if (!cancelled) {
          setContactLoadStatus('error')
          showToast({
            variant: 'error',
            title: 'Erreur',
            message: error instanceof Error ? error.message : 'Impossible de charger le responsable du compte.'
          })
        }
      }

      try {
        await loadDocuments()
        if (!cancelled) setDocumentsLoadStatus('success')
      } catch (error) {
        if (!cancelled) {
          setDocumentsLoadStatus('error')
          showToast({
            variant: 'error',
            title: 'Erreur',
            message: error instanceof Error ? error.message : 'Impossible de charger les documents.'
          })
        }
      }
    }

    void initialLoad()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleAddressChange(value: string) {
    setAddress(value)
    setGeocoded(undefined)
  }

  function handleSelectAddress(suggestion: AddressSuggestion) {
    setGeocoded({ lat: suggestion.lat, lng: suggestion.lng })
  }

  const primary = nullablePhone(phonePrimary)
  const secondary = nullablePhone(phoneSecondary)
  const primaryValid = primary !== null && FRENCH_PHONE_REGEX.test(primary)
  const secondaryValid = secondary === null || FRENCH_PHONE_REGEX.test(secondary)
  const isDirty =
    original !== undefined &&
    (name.trim() !== original.name ||
      primary !== original.phonePrimary ||
      secondary !== original.phoneSecondary ||
      logoUrl !== original.logoUrl ||
      address.trim() !== (original.address ?? '') ||
      geocoded?.lat !== (original.lat ?? undefined) ||
      geocoded?.lng !== (original.lng ?? undefined))

  const canSave =
    original !== undefined &&
    isDirty &&
    name.trim().length > 0 &&
    primaryValid &&
    secondaryValid &&
    address.trim().length > 0 &&
    !isSaving

  async function getAccessToken(): Promise<string> {
    const supabase = createSupabaseBrowserClient()
    const {
      data: { session }
    } = await supabase.auth.getSession()
    if (session?.access_token === undefined) {
      throw new Error('Session expirée, reconnectez-vous.')
    }
    return session.access_token
  }

  async function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return

    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      showToast({ variant: 'error', title: 'Format non pris en charge', message: 'Choisissez une image JPG ou PNG.' })
      return
    }
    if (file.size > MAX_LOGO_SIZE_BYTES) {
      showToast({ variant: 'error', title: 'Image trop volumineuse', message: 'Le logo ne doit pas dépasser 2 Mo.' })
      return
    }

    setIsUploadingLogo(true)
    try {
      const token = await getAccessToken()
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(`${apiUrl}/api/v1/merchants/me/logo`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: formData
      })
      const body: unknown = await response.json()
      const merchant = parseMerchantAccount(body)
      if (!response.ok || merchant === null) {
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : "L'envoi du logo a échoué."
        throw new Error(message)
      }

      setLogoUrl(merchant.logoUrl)
      setOriginal((current) => (current === undefined ? merchant : { ...current, logoUrl: merchant.logoUrl }))
      showToast({ variant: 'success', title: 'Logo mis à jour ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "L'envoi du logo a échoué."
      })
    } finally {
      setIsUploadingLogo(false)
    }
  }

  async function handleSave() {
    if (!canSave) return
    setIsSaving(true)

    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        // lat/lng ne sont jamais envoyés : le backend géocode l'adresse et
        // détermine la zone lui-même, il ne fait jamais confiance à des
        // coordonnées fournies par le client.
        body: JSON.stringify({
          name: name.trim(),
          address: address.trim(),
          phonePrimary: primary,
          phoneSecondary: secondary
        })
      })
      const body: unknown = await response.json()
      const merchant = parseMerchantAccount(body)
      if (!response.ok || merchant === null) {
        const errorCode = isRecord(body) && typeof body.error === 'string' ? body.error : undefined
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined
        throw new Error(saveErrorMessage(errorCode, message))
      }

      setName(merchant.name)
      setPhonePrimary(merchant.phonePrimary ?? '')
      setPhoneSecondary(merchant.phoneSecondary ?? '')
      setLogoUrl(merchant.logoUrl)
      setAddress(merchant.address ?? '')
      setGeocoded(merchant.lat !== null && merchant.lng !== null ? { lat: merchant.lat, lng: merchant.lng } : undefined)
      setOriginal(merchant)
      showToast({ variant: 'success', title: 'Informations enregistrées ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "L'enregistrement a échoué."
      })
    } finally {
      setIsSaving(false)
    }
  }

  function updateLegalAddress(field: keyof PostalAddress, value: string) {
    setLegalTouched(true)
    setLegalDraft((current) => ({
      ...current,
      legalAddress: { ...current.legalAddress, [field]: value || (field === 'line2' || field === 'communeCode' ? null : value) }
    }))
  }

  function updateBillingAddress(field: keyof PostalAddress, value: string) {
    setLegalTouched(true)
    setLegalDraft((current) => ({
      ...current,
      billingAddress: { ...current.billingAddress, [field]: value || (field === 'line2' || field === 'communeCode' ? null : value) }
    }))
  }

  const legalInformationValid =
    isValidSiret(legalDraft.siret) &&
    legalDraft.legalName.trim().length > 0 &&
    addressIsComplete(legalDraft.legalAddress) &&
    (!legalDraft.billingAddressDifferent || addressIsComplete(legalDraft.billingAddress))
  const legalInformationDirty =
    legalOriginal === undefined
      ? legalTouched
      : JSON.stringify({
          siret: normalizeSiret(legalDraft.siret),
          legalName: legalDraft.legalName.trim(),
          legalAddress: legalDraft.legalAddress,
          billingAddress: legalDraft.billingAddressDifferent ? legalDraft.billingAddress : null,
          vatNumber: legalDraft.vatNumber.trim() || null,
          vatRegime: legalDraft.vatRegime || null,
          legalForm: legalDraft.legalForm.trim() || null,
          buyerReference: legalDraft.buyerReference.trim() || null
        }) !==
        JSON.stringify({
          siret: legalOriginal.siret,
          legalName: legalOriginal.legalName,
          legalAddress: legalOriginal.legalAddress,
          billingAddress: legalOriginal.billingAddress,
          vatNumber: legalOriginal.vatNumber,
          vatRegime: legalOriginal.vatRegime,
          legalForm: legalOriginal.legalForm,
          buyerReference: legalOriginal.buyerReference
        })
  const canLookupSiret = isValidSiret(legalDraft.siret) && !isLookingUpSiret
  const canSaveLegalInformation = legalInformationDirty && !isSavingLegalInformation

  async function handleSiretLookup() {
    if (!canLookupSiret) return
    setIsLookingUpSiret(true)

    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/legal-information/siret-lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ siret: normalizeSiret(legalDraft.siret) })
      })
      const body: unknown = await response.json()
      const lookup = parseSireneLookupResult(body)
      if (!response.ok || lookup === null) {
        const errorCode = isRecord(body) && typeof body.error === 'string' ? body.error : undefined
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined
        throw new Error(legalInformationErrorMessage(errorCode, message))
      }

      setLegalTouched(true)
      setLegalDraft((current) => ({
        ...current,
        siret: lookup.siret,
        legalName: lookup.legalName ?? current.legalName,
        legalAddress: lookup.legalAddress === null ? current.legalAddress : clonePostalAddress(lookup.legalAddress),
        sireneVerificationStatus: lookup.sireneVerificationStatus,
        sireneWarning: lookup.warning
      }))
      showToast({
        variant: lookup.sireneVerificationStatus === 'verified' ? 'success' : 'error',
        title: lookup.sireneVerificationStatus === 'verified' ? 'Informations Sirene trouvées ✓' : 'Informations à compléter manuellement',
        ...(lookup.warning === null ? {} : { message: lookup.warning })
      })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Recherche Sirene indisponible',
        message: error instanceof Error ? error.message : 'Vous pouvez compléter les informations manuellement.'
      })
    } finally {
      setIsLookingUpSiret(false)
    }
  }

  async function handleSaveLegalInformation() {
    if (!canSaveLegalInformation) return
    if (!legalInformationValid) {
      setLegalSaveAttempted(true)
      return
    }
    setIsSavingLegalInformation(true)

    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/legal-information`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          siret: normalizeSiret(legalDraft.siret),
          legalName: legalDraft.legalName.trim(),
          legalAddress: legalDraft.legalAddress,
          billingAddress: legalDraft.billingAddressDifferent ? legalDraft.billingAddress : null,
          vatNumber: legalDraft.vatNumber.trim() || null,
          vatRegime: legalDraft.vatRegime || null,
          legalForm: legalDraft.legalForm.trim() || null,
          buyerReference: legalDraft.buyerReference.trim() || null
        })
      })
      const body: unknown = await response.json()
      const parsed = parseLegalInformationResponse(body)
      if (!response.ok || parsed === null || parsed.legalInformation === null) {
        const errorCode = isRecord(body) && typeof body.error === 'string' ? body.error : undefined
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined
        throw new Error(legalInformationErrorMessage(errorCode, message))
      }

      setElectronicInvoicingStatus(parsed.electronicInvoicingStatus)
      setLegalOriginal(parsed.legalInformation)
      setLegalDraft(toLegalInformationDraft(parsed.legalInformation))
      setLegalTouched(false)
      setLegalSaveAttempted(false)
      showToast({ variant: 'success', title: 'Informations légales enregistrées ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "L'enregistrement des informations légales a échoué."
      })
    } finally {
      setIsSavingLegalInformation(false)
    }
  }

  const contactPhoneValid = FRENCH_PHONE_REGEX.test(contactPhone.trim())
  const contactValid = contactFirstName.trim().length > 0 && contactLastName.trim().length > 0 && contactPhoneValid
  const contactDirty =
    contactOriginal === undefined ||
    contactFirstName.trim() !== contactOriginal.firstName ||
    contactLastName.trim() !== contactOriginal.lastName ||
    contactPhone.trim() !== contactOriginal.phone
  const canSaveContact = contactValid && contactDirty && !isSavingContact

  async function handleSaveAccountContact() {
    if (!canSaveContact) return
    setIsSavingContact(true)

    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/account-contact`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ firstName: contactFirstName.trim(), lastName: contactLastName.trim(), phone: contactPhone.trim() })
      })
      const body: unknown = await response.json()
      const parsed = parseAccountContact(body)
      if (!response.ok || parsed === null) {
        throw new Error("L'enregistrement du responsable du compte a échoué.")
      }
      setContactOriginal(parsed)
      setContactFirstName(parsed.firstName)
      setContactLastName(parsed.lastName)
      setContactPhone(parsed.phone)
      showToast({ variant: 'success', title: 'Responsable du compte enregistré ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "L'enregistrement du responsable du compte a échoué."
      })
    } finally {
      setIsSavingContact(false)
    }
  }

  const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024
  const ACCEPTED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png']

  async function handleUploadDocument(documentType: AccountDocumentType, event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return

    if (!ACCEPTED_DOCUMENT_TYPES.includes(file.type)) {
      showToast({ variant: 'error', title: 'Format non pris en charge', message: 'Choisissez un fichier PDF, JPEG ou PNG.' })
      return
    }
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      showToast({ variant: 'error', title: 'Fichier trop volumineux', message: 'Le document ne doit pas dépasser 10 Mo.' })
      return
    }

    setDocumentBusy(documentType)
    try {
      const token = await getAccessToken()
      const formData = new FormData()
      formData.append('file', file)
      formData.append('documentType', documentType)

      const response = await fetch(`${apiUrl}/api/v1/merchants/me/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: formData
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined
        throw new Error(message ?? "L'envoi du document a échoué.")
      }
      await loadDocuments()
      showToast({ variant: 'success', title: 'Document déposé ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "L'envoi du document a échoué."
      })
    } finally {
      setDocumentBusy(null)
    }
  }

  async function handleDeleteDocument(documentType: AccountDocumentType) {
    setDocumentBusy(documentType)
    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/documents/${documentType}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('La suppression du document a échoué.')
      await loadDocuments()
      showToast({ variant: 'success', title: 'Document supprimé ✓' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : 'La suppression du document a échoué.'
      })
    } finally {
      setDocumentBusy(null)
    }
  }

  const canChangeEmail = emailDraft.trim().length > 0 && emailDraft.trim() !== email && !isChangingEmail

  async function handleChangeEmail() {
    if (!canChangeEmail) return
    setIsChangingEmail(true)

    try {
      const supabase = createSupabaseBrowserClient()
      const nextEmail = emailDraft.trim()
      const { error } = await supabase.auth.updateUser({ email: nextEmail })
      if (error !== null) throw new Error(error.message)

      setEmail(nextEmail)
      showToast({ variant: 'success', title: 'Email à confirmer', message: 'Un email de confirmation a été envoyé.' })
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : "La modification de l'email a échoué."
      })
    } finally {
      setIsChangingEmail(false)
    }
  }

  const canChangePassword = newPassword.trim().length >= PASSWORD_MIN_LENGTH && !isChangingPassword

  async function handleChangePassword() {
    if (!canChangePassword) return
    setIsChangingPassword(true)

    try {
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.updateUser({ password: newPassword.trim() })
      if (error !== null) throw new Error(error.message)

      showToast({ variant: 'success', title: 'Mot de passe modifié ✓' })
      setNewPassword('')
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : 'La modification du mot de passe a échoué.'
      })
    } finally {
      setIsChangingPassword(false)
    }
  }

  if (loadStatus === 'loading') {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-border bg-surface p-6 shadow-md">
        <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="flex flex-col gap-5 pb-1">
        <h1 className="text-h2 font-bold text-stone-800">Mon Compte</h1>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <h2 className="mb-4 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Informations du commerce</h2>

          {loadStatus === 'error' ? (
            <p className="text-body-sm text-red-600">Impossible de charger les informations du commerce.</p>
          ) : (
            <div className="flex max-w-2xl flex-col gap-5 sm:flex-row sm:items-start">
              <div className="flex shrink-0 flex-col gap-2">
                <span className="text-body-sm font-semibold text-stone-800">Logo</span>
                <input ref={logoInputRef} type="file" accept="image/jpeg,image/png" className="sr-only" onChange={(event) => void handleLogoChange(event)} />
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={isUploadingLogo}
                  aria-label="Modifier le logo du commerce"
                  className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-primary-100 text-body-lg font-bold text-primary-700 outline-none ring-offset-2 transition focus:ring-2 focus:ring-primary-600 disabled:cursor-not-allowed"
                >
                  {logoUrl !== null ? (
                    <img src={logoUrl} alt={`Logo de ${name || 'votre commerce'}`} className="h-full w-full object-cover" />
                  ) : (
                    merchantInitials(name)
                  )}
                  <span className="absolute inset-x-0 bottom-0 flex h-8 items-center justify-center bg-stone-900/60 text-white" aria-hidden="true">
                    {isUploadingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                  </span>
                </button>
                <p className="text-label text-stone-400">JPG ou PNG, 2 Mo maximum</p>
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <Input label="Nom du commerce" placeholder="Le Terminus" value={name} onChange={(event) => setName(event.target.value)} required />

                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Téléphone"
                    type="tel"
                    inputMode="tel"
                    placeholder="04 74 00 00 00"
                    value={phonePrimary}
                    onChange={(event) => setPhonePrimary(event.target.value)}
                    onBlur={() => setPhonePrimaryTouched(true)}
                    error={
                      phonePrimaryTouched && primary === null
                        ? 'Le téléphone est requis'
                        : phonePrimaryTouched && !primaryValid
                          ? 'Numéro français invalide'
                          : undefined
                    }
                    required
                  />

                  <Input
                    label="Téléphone 2 (optionnel)"
                    type="tel"
                    inputMode="tel"
                    placeholder="06 12 34 56 78"
                    value={phoneSecondary}
                    onChange={(event) => setPhoneSecondary(event.target.value)}
                    onBlur={() => setPhoneSecondaryTouched(true)}
                    error={phoneSecondaryTouched && !secondaryValid ? 'Numéro français invalide' : undefined}
                  />
                </div>

                <div>
                  <AddressAutocomplete
                    label="Adresse"
                    placeholder="Place de la Grenette, 01000 Bourg-en-Bresse"
                    value={address}
                    onValueChange={handleAddressChange}
                    onSelectSuggestion={handleSelectAddress}
                    required
                  />
                  <p className={cn('mt-1.5 flex items-center gap-1.5 text-body-sm', geocoded !== undefined ? 'font-semibold text-primary-700' : 'text-stone-400')}>
                    <span aria-hidden="true">📍</span>
                    {isDirty && address.trim().length > 0
                      ? 'Adresse vérifiée à l’enregistrement'
                      : geocoded !== undefined
                        ? `${geocoded.lat.toFixed(4)}, ${geocoded.lng.toFixed(4)} ✓ Géolocalisée`
                        : '--'}
                  </p>
                </div>

                <Button type="button" onClick={() => void handleSave()} disabled={!canSave} className="mt-1 self-start">
                  {isSaving ? <><Loader2 className="h-4 w-4 animate-spin" />Enregistrement…</> : 'Enregistrer les modifications'}
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <h2 className="mb-1 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Responsable du compte</h2>
          <p className="mb-4 text-body-sm text-stone-600">Une personne de votre entreprise, sans vérification d’habilitation à ce stade.</p>

          {contactLoadStatus === 'error' ? (
            <p className="text-body-sm text-red-600">Impossible de charger le responsable du compte.</p>
          ) : (
            <div className="flex max-w-2xl flex-col gap-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Prénom" value={contactFirstName} onChange={(event) => setContactFirstName(event.target.value)} required />
                <Input label="Nom" value={contactLastName} onChange={(event) => setContactLastName(event.target.value)} required />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Email" type="email" value={email} disabled hint="Email du compte Locadely" />
                <Input
                  label="Téléphone"
                  type="tel"
                  inputMode="tel"
                  placeholder="06 12 34 56 78"
                  value={contactPhone}
                  onChange={(event) => setContactPhone(event.target.value)}
                  error={contactPhone.trim().length > 0 && !contactPhoneValid ? 'Numéro français invalide' : undefined}
                  required
                />
              </div>
              <Button type="button" onClick={() => void handleSaveAccountContact()} disabled={!canSaveContact} className="self-start">
                {isSavingContact ? <><Loader2 className="h-4 w-4 animate-spin" />Enregistrement…</> : 'Enregistrer le responsable'}
              </Button>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-body-sm font-semibold uppercase tracking-wide text-stone-400">Informations légales et facturation</h2>
              <p className="mt-1 text-body-sm text-stone-600">Ces informations identifient votre entreprise sur vos futures factures.</p>
            </div>
            <span className={cn('rounded-full px-3 py-1 text-label font-semibold', sireneStatusLabel(legalDraft.sireneVerificationStatus).className)}>
              {sireneStatusLabel(legalDraft.sireneVerificationStatus).label}
            </span>
          </div>

          {legalLoadStatus === 'loading' ? (
            <div className="flex h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>
          ) : legalLoadStatus === 'error' ? (
            <p className="text-body-sm text-red-600">Impossible de charger les informations légales.</p>
          ) : (
            <div className="flex max-w-2xl flex-col gap-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex-1">
                  <Input
                    label="SIRET"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="123 456 789 00012"
                    value={legalDraft.siret}
                    onChange={(event) => {
                      setLegalTouched(true)
                      setLegalDraft((current) => ({ ...current, siret: event.target.value, sireneVerificationStatus: 'unverified', sireneWarning: null }))
                    }}
                    error={
                      legalSaveAttempted
                        ? legalDraft.siret.trim().length === 0
                          ? 'Le SIRET est requis.'
                          : !isValidSiret(legalDraft.siret)
                            ? 'Le SIRET doit contenir 14 chiffres.'
                            : undefined
                        : undefined
                    }
                    hint="14 chiffres — les espaces sont acceptés"
                    required
                  />
                </div>
                <Button type="button" variant="secondary" onClick={() => void handleSiretLookup()} disabled={!canLookupSiret} className="sm:mt-[30px]">
                  {isLookingUpSiret ? <><Loader2 className="h-4 w-4 animate-spin" />Recherche…</> : 'Rechercher'}
                </Button>
              </div>

              {legalDraft.sireneWarning !== null && (
                <p className="rounded-md bg-accent-100 px-3.5 py-2.5 text-body-sm text-accent-800">{legalDraft.sireneWarning}</p>
              )}

              {electronicInvoicingStatusInfo(electronicInvoicingStatus) !== null && (
                <p className={cn('rounded-md px-3.5 py-2.5 text-body-sm', electronicInvoicingStatusInfo(electronicInvoicingStatus)?.className)}>
                  {electronicInvoicingStatusInfo(electronicInvoicingStatus)?.label}
                </p>
              )}

              <Input
                label="Raison sociale / Nom légal"
                placeholder="ABC RESTAURATION SAS"
                value={legalDraft.legalName}
                onChange={(event) => {
                  setLegalTouched(true)
                  setLegalDraft((current) => ({ ...current, legalName: event.target.value }))
                }}
                error={legalSaveAttempted && legalDraft.legalName.trim().length === 0 ? 'Le nom légal est requis.' : undefined}
                required
              />

              <fieldset className="flex flex-col gap-4">
                <legend className="text-body-sm font-semibold text-stone-800">Adresse légale</legend>
                <Input label="Adresse" placeholder="50 rue de la République" value={legalDraft.legalAddress.line1} onChange={(event) => updateLegalAddress('line1', event.target.value)} error={legalSaveAttempted && legalDraft.legalAddress.line1.trim().length === 0 ? "L'adresse légale est requise." : undefined} required />
                <Input label="Complément d'adresse (optionnel)" placeholder="Bâtiment, étage, boîte…" value={legalDraft.legalAddress.line2 ?? ''} onChange={(event) => updateLegalAddress('line2', event.target.value)} />
                <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                  <Input label="Code postal" inputMode="numeric" autoComplete="postal-code" placeholder="75001" value={legalDraft.legalAddress.postalCode} onChange={(event) => updateLegalAddress('postalCode', event.target.value)} error={legalSaveAttempted && legalDraft.legalAddress.postalCode.trim().length === 0 ? 'Le code postal est requis.' : undefined} required />
                  <Input label="Ville" autoComplete="address-level2" placeholder="Paris" value={legalDraft.legalAddress.city} onChange={(event) => updateLegalAddress('city', event.target.value)} error={legalSaveAttempted && legalDraft.legalAddress.city.trim().length === 0 ? 'La ville est requise.' : undefined} required />
                </div>
              </fieldset>

              <label className="flex cursor-pointer items-start gap-3 text-body-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={legalDraft.billingAddressDifferent}
                  onChange={(event) => {
                    setLegalTouched(true)
                    setLegalDraft((current) => ({ ...current, billingAddressDifferent: event.target.checked }))
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-stone-300 text-primary-600 focus:ring-primary-600"
                />
                <span><span className="font-semibold text-stone-800">Mon adresse de facturation est différente</span><br />Utilisez cette option si vos factures doivent être adressées à un autre site.</span>
              </label>

              {legalDraft.billingAddressDifferent && (
                <fieldset className="flex flex-col gap-4 rounded-xl border border-border bg-stone-50 p-4">
                  <legend className="px-1 text-body-sm font-semibold text-stone-800">Adresse de facturation</legend>
                  <Input label="Adresse" placeholder="12 avenue des Ternes" value={legalDraft.billingAddress.line1} onChange={(event) => updateBillingAddress('line1', event.target.value)} error={legalSaveAttempted && legalDraft.billingAddress.line1.trim().length === 0 ? "L'adresse de facturation est requise." : undefined} required />
                  <Input label="Complément d'adresse (optionnel)" placeholder="Bâtiment, étage, boîte…" value={legalDraft.billingAddress.line2 ?? ''} onChange={(event) => updateBillingAddress('line2', event.target.value)} />
                  <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                    <Input label="Code postal" inputMode="numeric" autoComplete="postal-code" placeholder="69002" value={legalDraft.billingAddress.postalCode} onChange={(event) => updateBillingAddress('postalCode', event.target.value)} error={legalSaveAttempted && legalDraft.billingAddress.postalCode.trim().length === 0 ? 'Le code postal est requis.' : undefined} required />
                    <Input label="Ville" autoComplete="address-level2" placeholder="Lyon" value={legalDraft.billingAddress.city} onChange={(event) => updateBillingAddress('city', event.target.value)} error={legalSaveAttempted && legalDraft.billingAddress.city.trim().length === 0 ? 'La ville est requise.' : undefined} required />
                  </div>
                </fieldset>
              )}

              <Input
                label="N° TVA intracommunautaire (optionnel)"
                placeholder="FR12 123456789"
                value={legalDraft.vatNumber}
                onChange={(event) => {
                  setLegalTouched(true)
                  setLegalDraft((current) => ({ ...current, vatNumber: event.target.value }))
                }}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vat-regime" className="text-body-sm font-semibold text-stone-800">Régime de TVA</label>
                  <select
                    id="vat-regime"
                    value={legalDraft.vatRegime}
                    onChange={(event) => {
                      setLegalTouched(true)
                      const value = event.target.value
                      setLegalDraft((current) => ({ ...current, vatRegime: value === '' ? '' : (value as VatRegime) }))
                    }}
                    className="h-14 w-full rounded-md border-[1.5px] border-border bg-surface px-3.5 text-body-lg text-stone-800 outline-none transition-colors duration-fast ease-default focus:border-primary-600"
                  >
                    <option value="">Non renseigné</option>
                    {VAT_REGIME_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <Input
                  label="Forme juridique (optionnel)"
                  placeholder="SARL, SAS, EI…"
                  value={legalDraft.legalForm}
                  onChange={(event) => {
                    setLegalTouched(true)
                    setLegalDraft((current) => ({ ...current, legalForm: event.target.value }))
                  }}
                />
              </div>

              <Input
                label="Référence acheteur / code de routage de facturation électronique (optionnel)"
                placeholder="Ex. DEPT-42"
                value={legalDraft.buyerReference}
                onChange={(event) => {
                  setLegalTouched(true)
                  setLegalDraft((current) => ({ ...current, buyerReference: event.target.value }))
                }}
                hint="À renseigner uniquement si votre plateforme de facturation ou votre service comptable vous a fourni une référence spécifique."
              />

              <Button type="button" onClick={() => void handleSaveLegalInformation()} disabled={!canSaveLegalInformation} className="self-start">
                {isSavingLegalInformation ? <><Loader2 className="h-4 w-4 animate-spin" />Enregistrement…</> : 'Enregistrer les informations légales'}
              </Button>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <h2 className="mb-1 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Documents</h2>
          <p className="mb-4 text-body-sm text-stone-600">Pièces privées, jamais accessibles publiquement.</p>

          {documentsLoadStatus === 'error' ? (
            <p className="text-body-sm text-red-600">Impossible de charger les documents.</p>
          ) : (
            <div className="flex max-w-2xl flex-col gap-4">
              <input ref={identityFileInputRef} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(event) => void handleUploadDocument('identity_document', event)} />
              <input ref={businessDocFileInputRef} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(event) => void handleUploadDocument('business_registration_document', event)} />

              {(['identity_document', 'business_registration_document'] as const).map((documentType) => {
                const current = documents.find((document) => document.documentType === documentType)
                const busy = documentBusy === documentType
                const inputRef = documentType === 'identity_document' ? identityFileInputRef : businessDocFileInputRef
                return (
                  <div key={documentType} className="flex flex-col gap-2 rounded-xl border border-border bg-stone-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-body-sm font-semibold text-stone-800">{DOCUMENT_LABELS[documentType].title}</p>
                      <p className="text-body-sm text-stone-500">
                        {current !== undefined ? `Déposé le ${new Date(current.uploadedAt).toLocaleDateString('fr-FR')}` : 'À déposer'}
                      </p>
                      <p className="text-label text-stone-400">{DOCUMENT_LABELS[documentType].hint}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : current !== undefined ? 'Remplacer' : 'Ajouter'}
                      </Button>
                      {current !== undefined && (
                        <Button type="button" variant="secondary" onClick={() => void handleDeleteDocument(documentType)} disabled={busy}>
                          Supprimer
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <SepaPaymentMethod
          email={email}
          billingDetails={legalOriginal === undefined ? null : {
            name: legalOriginal.legalName,
            email,
            address: legalOriginal.billingAddress ?? legalOriginal.legalAddress
          }}
          getAccessToken={getAccessToken}
        />

        <CardPayments getAccessToken={getAccessToken} />

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <h2 className="mb-4 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Compte</h2>

          <div className="flex max-w-xl flex-col gap-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input label="Email" type="email" autoComplete="email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} required />
              </div>
              <Button type="button" variant="secondary" onClick={() => void handleChangeEmail()} disabled={!canChangeEmail}>
                {isChangingEmail ? <><Loader2 className="h-4 w-4 animate-spin" />Modification…</> : "Modifier l'email"}
              </Button>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input label="Nouveau mot de passe" type="password" autoComplete="new-password" placeholder="••••••••" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} hint={`${PASSWORD_MIN_LENGTH} caractères minimum`} />
              </div>
              <Button type="button" variant="secondary" size="lg" onClick={() => void handleChangePassword()} disabled={!canChangePassword} className="sm:mb-[22px]">
                {isChangingPassword ? <><Loader2 className="h-4 w-4 animate-spin" />Modification…</> : 'Modifier le mot de passe'}
              </Button>
            </div>
          </div>
        </section>

      </div>
    </div>
  )
}
