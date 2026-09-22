'use client'

import { CreditCard, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '@/lib/config'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast-provider'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 6

// Contrat API `GET/POST /api/v1/merchants/me/card-payments` (voir docs/work/cod-payment-plan.md, T24).
type CardPaymentsState = 'not_configured' | 'action_required' | 'pending_review' | 'ready' | 'restricted'
type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'inactive' | 'not_requested'
type CardPaymentsStatus = {
  state: CardPaymentsState
  cardPaymentsReady: boolean
  cartesBancairesStatus: CapabilityStatus
  requirementsCount: number
}

type Props = { getAccessToken: () => Promise<string> }

const STATE_LABEL: Record<CardPaymentsState, { label: string; badge: string; cta: string | null; help: string }> = {
  not_configured: {
    label: 'Non configuré',
    badge: 'bg-stone-100 text-stone-700',
    cta: 'Activer les paiements par carte',
    help: 'Activez l’encaissement par carte pour proposer « Paiement à la livraison » à vos clients.'
  },
  action_required: {
    label: 'Configuration nécessaire',
    badge: 'bg-accent-100 text-accent-800',
    cta: 'Reprendre la configuration',
    help: 'Stripe a besoin de quelques informations pour activer votre compte.'
  },
  pending_review: {
    label: 'Vérification en cours',
    badge: 'bg-primary-50 text-primary-700',
    cta: null,
    help: 'Stripe vérifie vos informations. Cette page se met à jour automatiquement.'
  },
  restricted: {
    label: 'Informations supplémentaires requises',
    badge: 'bg-red-50 text-red-700',
    cta: 'Compléter mon dossier',
    help: 'Stripe demande des informations supplémentaires avant de pouvoir vous verser les paiements.'
  },
  ready: {
    label: 'Prêt à encaisser',
    badge: 'bg-primary-50 text-primary-700',
    cta: null,
    help: 'Vous pouvez demander des livraisons avec paiement à la livraison.'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStatus(body: unknown): CardPaymentsStatus | null {
  if (!isRecord(body) || typeof body.state !== 'string' || !(body.state in STATE_LABEL)) return null
  return {
    state: body.state as CardPaymentsState,
    cardPaymentsReady: body.cardPaymentsReady === true,
    cartesBancairesStatus: typeof body.cartesBancairesStatus === 'string' ? (body.cartesBancairesStatus as CapabilityStatus) : 'not_requested',
    requirementsCount: typeof body.requirementsCount === 'number' ? body.requirementsCount : 0
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// Le serveur ne renvoie que des codes stables : jamais de message technique brut.
function messageForCode(code: string | null): string {
  switch (code) {
    case 'LegalInformationRequired':
      return 'Complétez et enregistrez vos informations légales avant d’activer les paiements par carte.'
    case 'StripeUnavailable':
    case 'StripeProviderError':
      return 'Le service de paiement est indisponible. Réessayez dans quelques instants.'
    default:
      return 'Impossible de continuer pour le moment. Réessayez dans quelques instants.'
  }
}

export function CardPayments({ getAccessToken }: Props) {
  const { showToast } = useToast()
  // La page parente recrée `getAccessToken` à chaque rendu : on la lit via une ref mise à jour dans un effet.
  const getAccessTokenRef = useRef(getAccessToken)
  useEffect(() => {
    getAccessTokenRef.current = getAccessToken
  }, [getAccessToken])
  const [status, setStatus] = useState<CardPaymentsStatus | null | 'unavailable'>(null)
  const [starting, setStarting] = useState(false)
  const pollsRef = useRef(0)

  const load = useCallback(async () => {
    try {
      const token = await getAccessTokenRef.current()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/card-payments`, { headers: { authorization: `Bearer ${token}` } })
      const body = await readJson(response)
      const parsed = response.ok ? readStatus(body) : null
      setStatus(parsed ?? 'unavailable')
      return parsed
    } catch (error) {
      console.error('card-payments load', error instanceof Error ? `${error.name}: ${error.message}` : 'erreur inconnue')
      setStatus('unavailable')
      return null
    }
  }, [])

  useEffect(() => {
    // Chargement initial différé dans l'effet client (règles React sur les mises à jour asynchrones).
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (status === null || status === 'unavailable' || status.state !== 'pending_review') return
    const timer = window.setInterval(() => {
      pollsRef.current += 1
      if (pollsRef.current > MAX_POLLS) {
        window.clearInterval(timer)
        return
      }
      void load()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [status, load])

  async function startOnboarding() {
    setStarting(true)
    try {
      const token = await getAccessTokenRef.current()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/card-payments/onboarding-link`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      const body = await readJson(response)
      if (!response.ok) {
        const code = isRecord(body) && typeof body.error === 'string' ? body.error : null
        showToast({ variant: 'error', title: 'Activation impossible', message: messageForCode(code) })
        return
      }
      // Lien d'onboarding hébergé à usage unique (~10 min) : redirection immédiate.
      const url = isRecord(body) && typeof body.url === 'string' ? body.url : null
      if (url === null || !url.startsWith('https://')) {
        showToast({ variant: 'error', title: 'Activation impossible', message: messageForCode(null) })
        return
      }
      window.location.assign(url)
    } catch (error) {
      console.error('card-payments onboarding', error instanceof Error ? `${error.name}: ${error.message}` : 'erreur inconnue')
      showToast({ variant: 'error', title: 'Activation impossible', message: messageForCode(null) })
    } finally {
      setStarting(false)
    }
  }

  const view = status === null || status === 'unavailable' ? null : STATE_LABEL[status.state]

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
      <h2 className="text-body-sm font-semibold uppercase tracking-wide text-stone-400">Paiements par carte</h2>
      <p className="mt-1 text-body-sm text-stone-600">
        Encaissez vos clients par carte à la livraison. Le paiement arrive sur votre compte Stripe : Locadely ne prélève
        aucune commission sur ces paiements, les frais de traitement Stripe s’appliquent.
      </p>

      {status === null && (
        <div className="mt-4"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>
      )}

      {status === 'unavailable' && (
        <p className="mt-4 text-body-sm text-accent-800">Les paiements par carte ne sont pas disponibles pour le moment.</p>
      )}

      {view !== null && status !== null && status !== 'unavailable' && (
        <div className="mt-4 flex max-w-xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="h-5 w-5 text-stone-500" />
            <span className={cn('rounded-full px-3 py-1 text-body-sm font-semibold', view.badge)}>{view.label}</span>
          </div>
          <p className="text-body-sm text-stone-700">{view.help}</p>
          {status.state === 'restricted' && status.requirementsCount > 0 && (
            <p className="text-body-sm text-stone-600">
              {status.requirementsCount} information{status.requirementsCount > 1 ? 's' : ''} à fournir.
            </p>
          )}
          {status.state === 'ready' && status.cartesBancairesStatus !== 'active' && (
            <p className="text-body-sm text-stone-600">
              Cartes Bancaires : activation en cours. Les cartes Visa et Mastercard sont déjà acceptées.
            </p>
          )}
          {view.cta !== null && (
            <div>
              <Button type="button" onClick={() => void startOnboarding()} disabled={starting}>
                {starting ? <><Loader2 className="h-4 w-4 animate-spin" />Ouverture…</> : view.cta}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
