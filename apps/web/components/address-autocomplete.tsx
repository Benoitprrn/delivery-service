'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { MapPin } from 'lucide-react'
import { Input, type InputProps } from '@/components/ui/input'
import { openCageApiKey } from '@/lib/config'

const AUTOCOMPLETE_DEBOUNCE_MS = 400
const AUTOCOMPLETE_MIN_CHARS = 3

export type AddressSuggestion = {
  formatted: string
  lat: number
  lng: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function fetchAddressSuggestions(query: string): Promise<AddressSuggestion[]> {
  const url = new URL('https://api.opencagedata.com/geocode/v1/json')
  url.searchParams.set('q', query)
  url.searchParams.set('key', openCageApiKey)
  url.searchParams.set('language', 'fr')
  url.searchParams.set('countrycode', 'fr')
  url.searchParams.set('limit', '5')
  url.searchParams.set('no_annotations', '1')

  try {
    const response = await fetch(url)
    const body: unknown = await response.json()

    if (!response.ok || !isRecord(body) || !Array.isArray(body.results)) {
      return []
    }

    const parsed: AddressSuggestion[] = []
    for (const result of body.results) {
      if (!isRecord(result) || typeof result.formatted !== 'string' || !isRecord(result.geometry)) {
        continue
      }
      const { lat, lng } = result.geometry
      if (typeof lat === 'number' && typeof lng === 'number') {
        parsed.push({ formatted: result.formatted, lat, lng })
      }
    }
    return parsed
  } catch {
    return []
  }
}

export type AddressAutocompleteProps = Omit<InputProps, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  onSelectSuggestion: (suggestion: AddressSuggestion) => void
}

// Extrait de /merchant/new pour être réutilisé tel quel sur /merchant/account
// (même comportement d'autocomplete OpenCage) — ne gère que le champ adresse
// et ses suggestions ; tout affichage additionnel (prix estimé, statut de
// géocodage…) reste à la charge de la page appelante.
export function AddressAutocomplete({ value, onValueChange, onSelectSuggestion, onBlur, ...inputProps }: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fieldRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (fieldRef.current !== null && !fieldRef.current.contains(event.target as Node)) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [])

  // Déclenchée uniquement par la frappe utilisateur (onChange du champ),
  // jamais par un changement de la prop `value` venu d'ailleurs (pré-remplissage
  // depuis une réponse API, sélection d'une suggestion…) — sinon la liste de
  // suggestions se rouvrirait au chargement d'une page avec adresse existante.
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
    onValueChange(next)

    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
    }
    if (next.trim().length < AUTOCOMPLETE_MIN_CHARS) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(() => {
      void fetchAddressSuggestions(next.trim()).then((results) => {
        setSuggestions(results)
        setShowSuggestions(results.length > 0)
      })
    }, AUTOCOMPLETE_DEBOUNCE_MS)
  }

  function handleSelect(suggestion: AddressSuggestion) {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current)
    }
    setSuggestions([])
    setShowSuggestions(false)
    onValueChange(suggestion.formatted)
    onSelectSuggestion(suggestion)
  }

  return (
    <div ref={fieldRef} className="relative">
      <Input autoComplete="off" value={value} onChange={handleChange} onBlur={onBlur} {...inputProps} />
      {showSuggestions && suggestions.length > 0 && (
        <ul className="absolute z-dropdown mt-1 w-full divide-y divide-border overflow-hidden rounded-md border border-border bg-surface shadow-md">
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.formatted}-${index}`}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(suggestion)}
                className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-body-sm text-stone-700 transition-colors duration-fast ease-default hover:bg-stone-50"
              >
                <MapPin className="h-4 w-4 shrink-0 text-stone-400" />
                <span className="truncate">{suggestion.formatted}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
