'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AddressAutocomplete, type AddressSuggestion } from '@/components/address-autocomplete'
import { useToast } from '@/components/toast-provider'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/config'
import { cn } from '@/lib/utils'

// FR large : fixes et mobiles (01 à 09 en local, ou +33 1-9), espaces/points/tirets tolérés.
// Distinct de FRENCH_MOBILE_REGEX (/merchant/new) : le téléphone du commerce est souvent un fixe.
const FRENCH_PHONE_REGEX = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/
const PASSWORD_MIN_LENGTH = 6

type MerchantAccount = {
  name: string
  phone: string
  address: string
  lat: number
  lng: number
}

type GeoPoint = { lat: number; lng: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseMerchantAccount(body: unknown): MerchantAccount | null {
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    typeof body.phone !== 'string' ||
    typeof body.address !== 'string' ||
    typeof body.lat !== 'number' ||
    typeof body.lng !== 'number'
  ) {
    return null
  }
  return { name: body.name, phone: body.phone, address: body.address, lat: body.lat, lng: body.lng }
}

export default function AccountPage() {
  const { showToast } = useToast()

  const [loadStatus, setLoadStatus] = useState<'loading' | 'success' | 'error'>('loading')

  const [email, setEmail] = useState('')

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [geocoded, setGeocoded] = useState<GeoPoint | undefined>(undefined)
  const [original, setOriginal] = useState<MerchantAccount | undefined>(undefined)
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

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
    setEmail(session?.user.email ?? '')

    const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const body: unknown = await response.json()
    const parsed = parseMerchantAccount(body)
    if (!response.ok || parsed === null) {
      throw new Error('Impossible de charger les informations du commerce.')
    }

    setName(parsed.name)
    setPhone(parsed.phone)
    setAddress(parsed.address)
    setGeocoded({ lat: parsed.lat, lng: parsed.lng })
    setOriginal(parsed)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function initialLoad() {
      try {
        await loadAccount()
        if (!cancelled) {
          setLoadStatus('success')
        }
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

  const phoneValid = FRENCH_PHONE_REGEX.test(phone.trim())
  const isDirty =
    original !== undefined &&
    (name.trim() !== original.name ||
      phone.trim() !== original.phone ||
      address.trim() !== original.address ||
      geocoded?.lat !== original.lat ||
      geocoded?.lng !== original.lng)

  const canSave =
    original !== undefined &&
    isDirty &&
    name.trim().length > 0 &&
    phoneValid &&
    address.trim().length > 0 &&
    geocoded !== undefined &&
    !isSaving

  async function handleSave() {
    if (!canSave || geocoded === undefined) {
      return
    }
    setIsSaving(true)

    const trimmedName = name.trim()
    const trimmedPhone = phone.trim()
    const trimmedAddress = address.trim()

    try {
      const supabase = createSupabaseBrowserClient()
      const {
        data: { session }
      } = await supabase.auth.getSession()
      const token = session?.access_token
      if (token === undefined) {
        throw new Error('Session expirée, reconnectez-vous.')
      }

      const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: trimmedName,
          phone: trimmedPhone,
          address: trimmedAddress,
          lat: geocoded.lat,
          lng: geocoded.lng
        })
      })
      const body: unknown = await response.json()

      if (!response.ok) {
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : "L'enregistrement a échoué."
        throw new Error(message)
      }

      setName(trimmedName)
      setPhone(trimmedPhone)
      setAddress(trimmedAddress)
      setOriginal({ name: trimmedName, phone: trimmedPhone, address: trimmedAddress, lat: geocoded.lat, lng: geocoded.lng })
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

  const canChangePassword = newPassword.trim().length >= PASSWORD_MIN_LENGTH && !isChangingPassword

  async function handleChangePassword() {
    if (!canChangePassword) {
      return
    }
    setIsChangingPassword(true)

    try {
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.updateUser({ password: newPassword.trim() })
      if (error !== null) {
        throw new Error(error.message)
      }

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
          <div className="flex max-w-xl flex-col gap-4">
            <Input label="Nom commercial" placeholder="Le Terminus" value={name} onChange={(event) => setName(event.target.value)} required />

            <Input
              label="Téléphone"
              type="tel"
              inputMode="tel"
              placeholder="04 74 00 00 00"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onBlur={() => setPhoneTouched(true)}
              error={phoneTouched && phone.trim().length > 0 && !phoneValid ? 'Numéro français invalide' : undefined}
              required
            />

            <div>
              <AddressAutocomplete
                label="Adresse du commerce"
                placeholder="Place de la Grenette, 01000 Bourg-en-Bresse"
                value={address}
                onValueChange={handleAddressChange}
                onSelectSuggestion={handleSelectAddress}
                required
              />
              <p
                className={cn(
                  'mt-1.5 flex items-center gap-1.5 text-body-sm',
                  geocoded !== undefined ? 'font-semibold text-primary-700' : 'text-stone-400'
                )}
              >
                <span aria-hidden="true">📍</span>
                {geocoded !== undefined ? `${geocoded.lat.toFixed(4)}, ${geocoded.lng.toFixed(4)} ✓ Géocodé` : '--'}
              </p>
            </div>

            <Button type="button" onClick={() => void handleSave()} disabled={!canSave} className="mt-1 self-start">
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Enregistrement…
                </>
              ) : (
                'Enregistrer les modifications'
              )}
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
        <h2 className="mb-4 text-body-sm font-semibold uppercase tracking-wide text-stone-400">Compte</h2>

        <div className="flex max-w-xl flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span className="text-body-sm font-semibold text-stone-800">Email</span>
            <p className="text-body-lg text-stone-600">
              {email} <span className="text-body-sm text-stone-400">(non modifiable)</span>
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Input
                label="Nouveau mot de passe"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                hint={`${PASSWORD_MIN_LENGTH} caractères minimum`}
              />
            </div>
            <Button type="button" variant="secondary" onClick={() => void handleChangePassword()} disabled={!canChangePassword}>
              {isChangingPassword ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Modification…
                </>
              ) : (
                'Modifier le mot de passe'
              )}
            </Button>
          </div>
        </div>
      </section>
      </div>
    </div>
  )
}
