'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AddressAutocomplete, type AddressSuggestion } from '@/components/address-autocomplete'
import { PriceCard, type PriceCardStatus, type PriceEstimate } from '@/components/price-card'
import type { GeoJsonLineString } from '@/components/delivery-map'
import { useToast } from '@/components/toast-provider'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/config'
import { cn } from '@/lib/utils'
import {
  DELAY_OPTIONS,
  buildDayOptions,
  buildTimeSlots,
  filterSlotsForDay,
  formatHeureFr,
  slotToDate,
  type DayOption,
  type PickupScheduleBody,
  type TimeSlot
} from '@/lib/pickup-schedule'

// Leaflet touche `window` au chargement du module — doit rester hors SSR.
const DeliveryMap = dynamic(() => import('@/components/delivery-map').then((mod) => mod.DeliveryMap), { ssr: false })

// Mobile FR : 06/07 en local, ou +33 6/7 — espaces/points/tirets tolérés.
const FRENCH_MOBILE_REGEX = /^(?:\+33\s?|0)[67](?:[\s.-]?\d{2}){4}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ADDRESS_DEBOUNCE_MS = 500
const ASAP_ESTIMATE_MINUTES = 15

type CollectionKind = 'asap' | 'delay' | 'scheduled'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGeometry(value: unknown): value is GeoJsonLineString {
  return (
    isRecord(value) &&
    value.type === 'LineString' &&
    Array.isArray(value.coordinates) &&
    value.coordinates.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number'))
  )
}

function parseMerchantLocation(body: unknown): { lat: number; lng: number } | null {
  if (!isRecord(body) || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
    return null
  }
  return { lat: body.lat, lng: body.lng }
}

export default function NewOrderPage() {
  const { showToast } = useToast()

  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [addressComplement, setAddressComplement] = useState('')
  const [orderDetails, setOrderDetails] = useState('')
  const [deliveryInstructions, setDeliveryInstructions] = useState('')

  const [phoneTouched, setPhoneTouched] = useState(false)
  const [emailTouched, setEmailTouched] = useState(false)

  const [priceStatus, setPriceStatus] = useState<PriceCardStatus>('idle')
  const [estimate, setEstimate] = useState<PriceEstimate | undefined>(undefined)
  const [deliveryCoords, setDeliveryCoords] = useState<{ lat: number; lng: number } | undefined>(undefined)
  const [geometry, setGeometry] = useState<GeoJsonLineString | undefined>(undefined)

  const [merchantLocation, setMerchantLocation] = useState<{ lat: number; lng: number } | undefined>(undefined)

  const [collectionKind, setCollectionKind] = useState<CollectionKind>('asap')
  const [currentTime, setCurrentTime] = useState(() => new Date())
  const [delayMinutes, setDelayMinutes] = useState(30)
  const [delayEstimatedAt, setDelayEstimatedAt] = useState<Date | undefined>(undefined)
  // Initialisation paresseuse (pas un effet) : "maintenant" n'a besoin d'être
  // lu qu'une fois au montage pour construire les 7 jours et le premier
  // filtrage de créneaux — un useEffect qui appellerait setState de façon
  // synchrone déclencherait un rendu en cascade inutile.
  const [dayOptions] = useState<DayOption[]>(() => buildDayOptions(new Date()))
  const [selectedDayIndex, setSelectedDayIndex] = useState(0)
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>(() => filterSlotsForDay(buildTimeSlots(), 0, new Date()))
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | undefined>(() =>
    filterSlotsForDay(buildTimeSlots(), 0, new Date()).length > 0 ? 0 : undefined
  )
  const [isScheduleDialogOpen, setIsScheduleDialogOpen] = useState(false)
  const [draftDayIndex, setDraftDayIndex] = useState(0)
  const [draftSlotIndex, setDraftSlotIndex] = useState<number | undefined>(undefined)

  const [isSubmitting, setIsSubmitting] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastFetchedAddressRef = useRef('')
  const allSlotsRef = useRef<TimeSlot[]>(buildTimeSlots())

  const phoneValid = FRENCH_MOBILE_REGEX.test(phone.trim())
  const emailValid = email.trim().length === 0 || EMAIL_REGEX.test(email.trim())

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(new Date()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadMerchantLocation() {
      try {
        const supabase = createSupabaseBrowserClient()
        const {
          data: { session }
        } = await supabase.auth.getSession()
        const token = session?.access_token
        if (token === undefined) {
          return
        }
        const response = await fetch(`${apiUrl}/api/v1/merchants/me`, {
          headers: { authorization: `Bearer ${token}` }
        })
        const body: unknown = await response.json()
        const parsed = parseMerchantLocation(body)
        if (!cancelled && response.ok && parsed !== null) {
          setMerchantLocation(parsed)
        }
      } catch {
        // La carte reste simplement masquée si le profil commerçant n'a pas pu être chargé.
      }
    }

    void loadMerchantLocation()
    return () => {
      cancelled = true
    }
  }, [])

  function openScheduleDialog() {
    const nextDayIndex = collectionKind === 'scheduled' ? selectedDayIndex : 0
    const selectedSlot = selectedSlotIndex === undefined ? undefined : availableSlots[selectedSlotIndex]

    setDraftDayIndex(nextDayIndex)
    setDraftSlotIndex(collectionKind === 'scheduled' && selectedSlot !== undefined ? allSlotsRef.current.indexOf(selectedSlot) : undefined)
    setIsScheduleDialogOpen(true)
  }

  function confirmSchedule() {
    if (draftSlotIndex === undefined) {
      return
    }

    const slot = allSlotsRef.current[draftSlotIndex]
    const slots = filterSlotsForDay(allSlotsRef.current, draftDayIndex, new Date())
    const slotIndex = slot === undefined ? -1 : slots.indexOf(slot)
    if (slotIndex === -1) {
      return
    }

    setSelectedDayIndex(draftDayIndex)
    setAvailableSlots(slots)
    setSelectedSlotIndex(slotIndex)
    setCollectionKind('scheduled')
    setIsScheduleDialogOpen(false)
  }

  async function fetchEstimate(rawAddress: string) {
    const trimmed = rawAddress.trim()
    if (trimmed.length === 0) {
      setPriceStatus('idle')
      setEstimate(undefined)
      setDeliveryCoords(undefined)
      setGeometry(undefined)
      return
    }
    if (trimmed === lastFetchedAddressRef.current && priceStatus !== 'idle') {
      return
    }
    lastFetchedAddressRef.current = trimmed
    setPriceStatus('loading')

    try {
      const supabase = createSupabaseBrowserClient()
      const {
        data: { session }
      } = await supabase.auth.getSession()
      const token = session?.access_token
      if (token === undefined) {
        throw new Error('Session expirée, reconnectez-vous.')
      }

      const response = await fetch(`${apiUrl}/api/v1/orders/estimate?deliveryAddress=${encodeURIComponent(trimmed)}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      const body: unknown = await response.json()

      if (
        !response.ok ||
        !isRecord(body) ||
        typeof body.distanceM !== 'number' ||
        typeof body.durationS !== 'number' ||
        typeof body.priceCents !== 'number' ||
        typeof body.deliveryLat !== 'number' ||
        typeof body.deliveryLng !== 'number'
      ) {
        throw new Error('Adresse non reconnue')
      }

      setEstimate({ distanceM: body.distanceM, durationS: body.durationS, priceCents: body.priceCents })
      setDeliveryCoords({ lat: body.deliveryLat, lng: body.deliveryLng })
      setGeometry(isGeometry(body.geometry) ? body.geometry : undefined)
      setPriceStatus('success')
    } catch {
      setEstimate(undefined)
      setDeliveryCoords(undefined)
      setGeometry(undefined)
      setPriceStatus('error')
    }
  }

  useEffect(() => {
    if (address.trim().length === 0) {
      return
    }

    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      void fetchEstimate(address)
    }, ADDRESS_DEBOUNCE_MS)

    return () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  function handleAddressChange(value: string) {
    setAddress(value)
    // Réponse directe à l'action utilisateur (pas un effet) : vider le champ
    // doit réinitialiser la carte prix immédiatement, sans attendre le debounce.
    if (value.trim().length === 0) {
      setPriceStatus('idle')
      setEstimate(undefined)
      setDeliveryCoords(undefined)
      setGeometry(undefined)
      lastFetchedAddressRef.current = ''
    }
  }

  function handleSelectSuggestion(suggestion: AddressSuggestion) {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
    }
    setAddress(suggestion.formatted)
    void fetchEstimate(suggestion.formatted)
  }

  function handleAddressBlur() {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
    }
    void fetchEstimate(address)
  }

  function resetForm() {
    setCustomerName('')
    setPhone('')
    setEmail('')
    setAddress('')
    setAddressComplement('')
    setOrderDetails('')
    setDeliveryInstructions('')
    setCollectionKind('asap')
    setDelayMinutes(30)
    setDelayEstimatedAt(undefined)
    setSelectedDayIndex(0)
    const slots = filterSlotsForDay(allSlotsRef.current, 0, new Date())
    setAvailableSlots(slots)
    setSelectedSlotIndex(slots.length > 0 ? 0 : undefined)
    setPhoneTouched(false)
    setEmailTouched(false)
    setPriceStatus('idle')
    setEstimate(undefined)
    setDeliveryCoords(undefined)
    setGeometry(undefined)
    lastFetchedAddressRef.current = ''
  }

  const selectedDay = dayOptions[selectedDayIndex]
  const selectedSlot = selectedSlotIndex !== undefined ? availableSlots[selectedSlotIndex] : undefined
  const draftAvailableSlots = filterSlotsForDay(allSlotsRef.current, draftDayIndex, new Date())
  const draftSlot = draftSlotIndex === undefined ? undefined : allSlotsRef.current[draftSlotIndex]
  const draftScheduleLabel =
    draftSlot === undefined || dayOptions[draftDayIndex] === undefined
      ? undefined
      : draftDayIndex === 0
        ? `Collecte programmée aujourd'hui à ${draftSlot.displayLabel}`
        : `Collecte programmée le ${dayOptions[draftDayIndex].label} à ${draftSlot.displayLabel}`

  function buildPickupSchedule(): PickupScheduleBody | undefined {
    if (collectionKind === 'asap') {
      return { mode: 'asap' }
    }
    if (collectionKind === 'delay') {
      return { mode: 'delay', delayMinutes }
    }
    if (selectedDay === undefined || selectedSlot === undefined) {
      return undefined
    }
    return { mode: 'scheduled', at: slotToDate(selectedDay.ymd, selectedSlot).toISOString() }
  }

  function collectionConfirmationLabel(): string {
    if (collectionKind === 'asap') {
      const estimatedAt = new Date(currentTime.getTime() + ASAP_ESTIMATE_MINUTES * 60_000)
      return `Collecte estimée avant ${formatHeureFr(estimatedAt)}`
    }
    if (collectionKind === 'delay') {
      return delayEstimatedAt !== undefined ? `Collecte estimée vers ${formatHeureFr(delayEstimatedAt)}` : ''
    }
    if (selectedDay === undefined || selectedSlot === undefined) {
      return 'Choisissez un jour et un créneau'
    }
    const at = slotToDate(selectedDay.ymd, selectedSlot)
    return selectedDayIndex === 0
      ? `Collecte programmée aujourd'hui à ${formatHeureFr(at)}`
      : `Collecte programmée le ${selectedDay.label} à ${formatHeureFr(at)}`
  }

  const pickupSchedule = buildPickupSchedule()

  const canSubmit =
    customerName.trim().length > 0 &&
    phoneValid &&
    emailValid &&
    address.trim().length > 0 &&
    deliveryCoords !== undefined &&
    priceStatus === 'success' &&
    pickupSchedule !== undefined &&
    !isSubmitting

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || deliveryCoords === undefined || pickupSchedule === undefined) {
      return
    }

    setIsSubmitting(true)

    try {
      const supabase = createSupabaseBrowserClient()
      const {
        data: { session }
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const merchantId = session?.user.id
      if (token === undefined || merchantId === undefined) {
        throw new Error('Session expirée, reconnectez-vous.')
      }

      const response = await fetch(`${apiUrl}/api/v1/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          merchantId,
          customerName: customerName.trim(),
          customerPhone: phone.trim(),
          ...(email.trim().length > 0 ? { customerEmail: email.trim() } : {}),
          deliveryAddress: address.trim(),
          deliveryLat: deliveryCoords.lat,
          deliveryLng: deliveryCoords.lng,
          pickupScheduledAt: pickupSchedule,
          ...(orderDetails.trim().length > 0 ? { orderDetails: orderDetails.trim() } : {}),
          ...(deliveryInstructions.trim().length > 0 ? { deliveryInstructions: deliveryInstructions.trim() } : {}),
          ...(addressComplement.trim().length > 0 ? { deliveryAddressComplement: addressComplement.trim() } : {})
        })
      })
      const body: unknown = await response.json()

      if (!response.ok) {
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'La création de la livraison a échoué.'
        throw new Error(message)
      }

      showToast({ variant: 'success', title: 'Livraison créée ✓' })
      resetForm()
    } catch (error) {
      showToast({
        variant: 'error',
        title: 'Erreur',
        message: error instanceof Error ? error.message : 'La création de la livraison a échoué.'
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const distanceLabel =
    priceStatus === 'success' && estimate !== undefined
      ? `${(estimate.distanceM / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
      : undefined
  const durationLabel =
    priceStatus === 'success' && estimate !== undefined ? `${Math.round(estimate.durationS / 60)} min` : undefined
  const priceLabel =
    priceStatus === 'success' && estimate !== undefined
      ? `${(estimate.priceCents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : undefined

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-md md:h-full md:flex-row">
      <div className="flex-1 p-5 md:h-full md:overflow-y-auto md:p-6">
        <h1 className="mb-4 text-h2 font-bold text-stone-800">Demander une livraison</h1>

        <form onSubmit={handleSubmit} noValidate className="flex flex-1 flex-col gap-5">
          <section>
            <h2 className="mb-3 text-h3 font-semibold text-stone-800">Infos client</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="Nom complet"
                placeholder="Jean Dupont"
                autoComplete="name"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                required
              />
              <Input
                label="Téléphone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="06 12 34 56 78"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                onBlur={() => setPhoneTouched(true)}
                error={phoneTouched && phone.trim().length > 0 && !phoneValid ? 'Numéro français invalide' : undefined}
                required
              />
            </div>
            <div className="mt-3">
              <Input
                label="Email (optionnel)"
                type="email"
                autoComplete="email"
                placeholder="vous@exemple.fr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => setEmailTouched(true)}
                error={emailTouched && email.trim().length > 0 && !emailValid ? 'Adresse email invalide' : undefined}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-h3 font-semibold text-stone-800">Livraison</h2>
            <AddressAutocomplete
              label="Adresse de livraison"
              placeholder="12 rue de la République, Bourg-en-Bresse"
              value={address}
              onValueChange={handleAddressChange}
              onSelectSuggestion={handleSelectSuggestion}
              onBlur={handleAddressBlur}
              required
            />
            <PriceCard status={priceStatus} estimate={estimate} />
            <div className="mt-3">
              <Input
                label="Complément d'adresse (optionnel)"
                placeholder="Bâtiment B, 3ᵉ étage, interphone 42"
                value={addressComplement}
                onChange={(event) => setAddressComplement(event.target.value)}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-h3 font-semibold text-stone-800">Informations complémentaires</h2>
            <div className="flex flex-col gap-3">
              <Textarea
                label="Détails commande (optionnel)"
                placeholder="2 menus, 1 sans oignon…"
                value={orderDetails}
                onChange={(event) => setOrderDetails(event.target.value)}
              />
              <Textarea
                label="Commentaire livreur (optionnel)"
                placeholder="Code portail 1234, livrer à l'arrière du bâtiment…"
                value={deliveryInstructions}
                onChange={(event) => setDeliveryInstructions(event.target.value)}
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-h3 font-semibold text-stone-800">Collecte</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setCollectionKind('asap')}
                className={cn(
                  'rounded-lg border px-4 py-2 text-body-sm font-medium transition-colors duration-fast ease-default',
                  collectionKind === 'asap'
                    ? 'border-primary-600 bg-primary-50 text-primary-700'
                    : 'border-border text-stone-600 hover:bg-stone-50'
                )}
              >
                Dès que possible
              </button>
              {DELAY_OPTIONS.map((option) => (
                <button
                  key={option.delayMinutes}
                  type="button"
                  onClick={() => {
                    setCollectionKind('delay')
                    setDelayMinutes(option.delayMinutes)
                    setDelayEstimatedAt(new Date(Date.now() + option.delayMinutes * 60_000))
                  }}
                  className={cn(
                    'rounded-lg border px-4 py-2 text-body-sm font-medium transition-colors duration-fast ease-default',
                    collectionKind === 'delay' && delayMinutes === option.delayMinutes
                      ? 'border-primary-600 bg-primary-50 text-primary-700'
                      : 'border-border text-stone-600 hover:bg-stone-50'
                  )}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                onClick={openScheduleDialog}
                className={cn(
                  'rounded-lg border px-4 py-2 text-body-sm font-medium transition-colors duration-fast ease-default',
                  collectionKind === 'scheduled'
                    ? 'border-primary-600 bg-primary-50 text-primary-700'
                    : 'border-border text-stone-600 hover:bg-stone-50'
                )}
              >
                Programmé
              </button>
            </div>

            <p className="mt-3 text-body-sm font-semibold text-primary-700">{collectionConfirmationLabel()}</p>
          </section>

          <Button type="submit" size="lg" fullWidth disabled={!canSubmit} className="mt-1">
            {isSubmitting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Création…
              </>
            ) : (
              'Demander une livraison →'
            )}
          </Button>
        </form>
      </div>

      <Dialog open={isScheduleDialogOpen} onOpenChange={setIsScheduleDialogOpen}>
        <DialogContent className="inset-auto left-1/2 top-1/2 h-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border shadow-xl">
          <DialogHeader className="shrink-0 pr-14">
            <DialogTitle>Choisir un créneau</DialogTitle>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4 md:px-6">
            <div className="-mx-5 flex shrink-0 gap-2 overflow-x-auto px-5 pb-4 md:-mx-6 md:px-6">
              {dayOptions.map((day, index) => (
                <button
                  key={`${day.ymd.year}-${day.ymd.month}-${day.ymd.day}`}
                  type="button"
                  onClick={() => {
                    setDraftDayIndex(index)
                    setDraftSlotIndex(undefined)
                  }}
                  aria-pressed={draftDayIndex === index}
                  className={cn(
                    'h-11 shrink-0 rounded-lg border px-4 text-body-sm font-semibold transition-colors duration-fast ease-default',
                    draftDayIndex === index
                      ? 'border-primary-600 bg-primary-600 text-white'
                      : 'border-border text-stone-600 hover:bg-stone-50'
                  )}
                >
                  {day.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 max-h-[min(50dvh,360px)] overflow-y-auto pr-1">
              <div className="grid grid-cols-5 gap-2">
                {allSlotsRef.current.map((slot, index) => {
                  const isAvailable = draftAvailableSlots.includes(slot)
                  const isSelected = draftSlotIndex === index

                  return (
                    <button
                      key={`${slot.hour}-${slot.minute}-${slot.isMidnight}`}
                      type="button"
                      disabled={!isAvailable}
                      onClick={() => setDraftSlotIndex(index)}
                      className={cn(
                        'h-11 rounded-lg border text-body-sm font-semibold transition-colors duration-fast ease-default',
                        isSelected ? 'border-primary-600 bg-primary-600 text-white' : 'border-border text-stone-700 hover:bg-primary-50',
                        !isAvailable && 'cursor-not-allowed border-stone-100 bg-stone-50 text-stone-300 hover:bg-stone-50'
                      )}
                    >
                      {slot.displayLabel}
                    </button>
                  )
                })}
              </div>
            </div>

            <Button type="button" size="lg" fullWidth disabled={draftScheduleLabel === undefined} onClick={confirmSchedule} className="mt-5 shrink-0">
              {draftScheduleLabel ?? 'Confirmer le créneau'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {merchantLocation !== undefined && (
        <div className="h-72 shrink-0 overflow-hidden md:sticky md:top-0 md:h-full md:w-[45%]">
          <DeliveryMap
            pickup={merchantLocation}
            delivery={deliveryCoords}
            geometry={geometry}
            distanceLabel={distanceLabel}
            durationLabel={durationLabel}
            priceLabel={priceLabel}
          />
        </div>
      )}
    </div>
  )
}
