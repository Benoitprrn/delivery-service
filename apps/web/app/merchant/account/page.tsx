'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AddressAutocomplete, type AddressSuggestion } from '@/components/address-autocomplete'
import { useToast } from '@/components/toast-provider'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/config'
import { cn } from '@/lib/utils'

const FRENCH_PHONE_REGEX = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/
const PASSWORD_MIN_LENGTH = 6
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024

type MerchantAccount = {
  name: string
  phoneLandline: string | null
  phoneMobile: string | null
  logoUrl: string | null
  address: string
  lat: number
  lng: number
}

type GeoPoint = { lat: number; lng: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function parseMerchantAccount(body: unknown): MerchantAccount | null {
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    !isNullableString(body.phoneLandline) ||
    !isNullableString(body.phoneMobile) ||
    !isNullableString(body.logoUrl) ||
    typeof body.address !== 'string' ||
    typeof body.lat !== 'number' ||
    typeof body.lng !== 'number'
  ) {
    return null
  }

  return {
    name: body.name,
    phoneLandline: body.phoneLandline,
    phoneMobile: body.phoneMobile,
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
  const [phoneLandline, setPhoneLandline] = useState('')
  const [phoneMobile, setPhoneMobile] = useState('')
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [geocoded, setGeocoded] = useState<GeoPoint | undefined>(undefined)
  const [original, setOriginal] = useState<MerchantAccount | undefined>(undefined)
  const [phonesTouched, setPhonesTouched] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploadingLogo, setIsUploadingLogo] = useState(false)

  const [newPassword, setNewPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)

  const loadAccount = useCallback(async (): Promise<void> => {
    const supabase = createSupabaseBrowserClient()
    const {
      data: { session }
    } = await supabase.auth.getSession()
    const token = session?.access_token
    if (token === undefined) {
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
    setPhoneLandline(parsed.phoneLandline ?? '')
    setPhoneMobile(parsed.phoneMobile ?? '')
    setLogoUrl(parsed.logoUrl)
    setAddress(parsed.address)
    setGeocoded({ lat: parsed.lat, lng: parsed.lng })
    setOriginal(parsed)
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

  const landline = nullablePhone(phoneLandline)
  const mobile = nullablePhone(phoneMobile)
  const landlineValid = landline === null || FRENCH_PHONE_REGEX.test(landline)
  const mobileValid = mobile === null || FRENCH_PHONE_REGEX.test(mobile)
  const hasPhone = landline !== null || mobile !== null
  const showMissingPhoneError = phonesTouched && !hasPhone
  const isDirty =
    original !== undefined &&
    (name.trim() !== original.name ||
      landline !== original.phoneLandline ||
      mobile !== original.phoneMobile ||
      logoUrl !== original.logoUrl ||
      address.trim() !== original.address ||
      geocoded?.lat !== original.lat ||
      geocoded?.lng !== original.lng)

  const canSave =
    original !== undefined &&
    isDirty &&
    name.trim().length > 0 &&
    hasPhone &&
    landlineValid &&
    mobileValid &&
    address.trim().length > 0 &&
    geocoded !== undefined &&
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
    if (!canSave || geocoded === undefined) return
    setIsSaving(true)

    try {
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: name.trim(),
          phoneLandline: landline,
          phoneMobile: mobile,
          logoUrl,
          address: address.trim(),
          lat: geocoded.lat,
          lng: geocoded.lng
        })
      })
      const body: unknown = await response.json()
      const merchant = parseMerchantAccount(body)
      if (!response.ok || merchant === null) {
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : "L'enregistrement a échoué."
        throw new Error(message)
      }

      setName(merchant.name)
      setPhoneLandline(merchant.phoneLandline ?? '')
      setPhoneMobile(merchant.phoneMobile ?? '')
      setLogoUrl(merchant.logoUrl)
      setAddress(merchant.address)
      setGeocoded({ lat: merchant.lat, lng: merchant.lng })
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
                <Input label="Nom commercial" placeholder="Le Terminus" value={name} onChange={(event) => setName(event.target.value)} required />

                <div className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Téléphone fixe"
                    type="tel"
                    inputMode="tel"
                    placeholder="04 74 00 00 00"
                    value={phoneLandline}
                    onChange={(event) => setPhoneLandline(event.target.value)}
                    onBlur={() => setPhonesTouched(true)}
                    error={phonesTouched && !landlineValid ? 'Numéro français invalide' : undefined}
                  />

                  <Input
                    label="Téléphone portable"
                    type="tel"
                    inputMode="tel"
                    placeholder="06 00 00 00 00"
                    value={phoneMobile}
                    onChange={(event) => setPhoneMobile(event.target.value)}
                    onBlur={() => setPhonesTouched(true)}
                    error={phonesTouched && !mobileValid ? 'Numéro français invalide' : undefined}
                  />
                </div>
                {showMissingPhoneError && <p role="alert" className="-mt-2 text-label text-red-600">Au moins un numéro de téléphone est requis.</p>}

                <div>
                  <AddressAutocomplete
                    label="Adresse du commerce"
                    placeholder="Place de la Grenette, 01000 Bourg-en-Bresse"
                    value={address}
                    onValueChange={handleAddressChange}
                    onSelectSuggestion={handleSelectAddress}
                    required
                  />
                  <p className={cn('mt-1.5 flex items-center gap-1.5 text-body-sm', geocoded !== undefined ? 'font-semibold text-primary-700' : 'text-stone-400')}>
                    <span aria-hidden="true">📍</span>
                    {geocoded !== undefined ? `${geocoded.lat.toFixed(4)}, ${geocoded.lng.toFixed(4)} ✓ Géocodé` : '--'}
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

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
          <h2 className="mb-4 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Paiement</h2>
          <div className="flex max-w-xl flex-col gap-3">
            <div>
              <h3 className="text-body-lg font-semibold text-stone-800">Paiement à la livraison</h3>
              <p className="mt-1 text-body text-stone-600">Connectez votre compte Stripe pour accepter les paiements à la livraison</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled><Link2 className="h-4 w-4" />Connecter Stripe</Button>
              <span className="rounded-full bg-stone-100 px-3 py-1 text-label font-semibold text-stone-500">Bientôt disponible</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
