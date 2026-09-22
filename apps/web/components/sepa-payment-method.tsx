'use client'

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type Appearance } from '@stripe/stripe-js'
import { CreditCard, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '@/lib/config'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast-provider'
import { toStripeBillingDetails } from '@/lib/stripe-billing-details'

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
const stripePromise = publishableKey === undefined || publishableKey === '' ? null : loadStripe(publishableKey)

const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 6

// Le Payment Element vit dans une iframe Stripe : les tokens Terrain ne peuvent pas
// être hérités par variables CSS, ils sont donc recopiés ici (colors.css / effects.css).
const appearance: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#059669',
    colorBackground: '#FFFFFF',
    colorText: '#292524',
    colorTextSecondary: '#78716C',
    colorDanger: '#DC2626',
    fontFamily: '"DM Sans", system-ui, -apple-system, sans-serif',
    fontSizeBase: '16px',
    borderRadius: '10px',
    spacingUnit: '4px'
  },
  rules: {
    '.Label': { fontWeight: '600', color: '#292524' },
    '.Input': { border: '1.5px solid #E7E0D5', boxShadow: 'none', padding: '14px' },
    '.Input:focus': { border: '1.5px solid #059669', boxShadow: 'none' }
  }
}
const elementsFonts = [{ cssSrc: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap' }]

type PaymentMethod = { bankName: string | null; last4: string | null; country: string | null; status: 'active' | 'invalid' }
type BillingDetails = {
  name: string
  email: string
  address: { line1: string; line2: string | null; city: string; postalCode: string; countryCode: string }
}
type Props = { email: string; billingDetails: BillingDetails | null; getAccessToken: () => Promise<string> }

type Notice = { variant: 'error' | 'info' | 'success'; title: string; message?: string }

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  return typeof body.error === 'string' ? body.error : null
}

function readPaymentMethod(body: unknown): PaymentMethod | null | undefined {
  if (typeof body !== 'object' || body === null || !('paymentMethod' in body)) return undefined
  return (body as { paymentMethod: PaymentMethod | null }).paymentMethod
}

// Le serveur ne renvoie que des codes stables : aucun message technique n'est affiché tel quel.
function noticeForCode(code: string | null, fallbackTitle: string): Notice {
  switch (code) {
    case 'LegalInformationRequired':
      return {
        variant: 'error',
        title: 'Informations légales incomplètes',
        message: 'Complétez et enregistrez vos informations légales avant de configurer le mandat.'
      }
    case 'SetupProcessing':
      return {
        variant: 'info',
        title: 'Validation en cours',
        message: 'Votre banque valide encore le mandat. Cette page se mettra à jour automatiquement.'
      }
    case 'SetupAlreadyCompleted':
      return { variant: 'success', title: 'Mandat bancaire enregistré' }
    case 'AccountEmailUnavailable':
      return {
        variant: 'error',
        title: 'E-mail de compte indisponible',
        message: 'Reconnectez-vous puis réessayez.'
      }
    case 'CustomerCreationInProgress':
      return {
        variant: 'info',
        title: 'Préparation en cours',
        message: 'Votre espace de paiement se prépare. Réessayez dans quelques secondes.'
      }
    case 'StripeUnavailable':
    case 'StripeProviderError':
      return {
        variant: 'error',
        title: 'Service de paiement indisponible',
        message: 'Réessayez dans quelques instants.'
      }
    case 'PaymentMethodNotReady':
    case 'SetupNotCompleted':
      return {
        variant: 'error',
        title: fallbackTitle,
        message: 'Cette configuration n’est plus valide. Relancez l’ajout du compte bancaire.'
      }
    default:
      return { variant: 'error', title: fallbackTitle, message: 'Une erreur est survenue. Réessayez.' }
  }
}

type SetupFormProps = {
  billingDetails: BillingDetails
  getAccessToken: () => Promise<string>
  onComplete: (payment: PaymentMethod) => void
  onProcessing: () => void
  onRefresh: () => void
  onCancel: () => void
}

function SetupForm({ billingDetails, getAccessToken, onComplete, onProcessing, onRefresh, onCancel }: SetupFormProps) {
  const stripe = useStripe()
  const elements = useElements()
  const { showToast } = useToast()
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (stripe === null || elements === null) return
    setSaving(true)
    try {
      // Les erreurs de saisie sont affichées par le Payment Element lui-même.
      const submitted = await elements.submit()
      if (submitted.error !== undefined) return

      const confirmed = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: {
          payment_method_data: {
            billing_details: toStripeBillingDetails(billingDetails)
          }
        }
      })
      if (confirmed.error !== undefined) {
        // Stripe rédige lui-même les erreurs de saisie destinées au client ; les autres types
        // (api_error, invalid_request_error…) sont techniques et ne sont jamais affichés tels quels.
        const userFacing = confirmed.error.type === 'validation_error' || confirmed.error.type === 'card_error'
        showToast({
          variant: 'error',
          title: 'Impossible d’enregistrer le mandat',
          message: userFacing && confirmed.error.message !== undefined ? confirmed.error.message : 'La confirmation a échoué. Réessayez.'
        })
        return
      }
      const setupIntentStatus = confirmed.setupIntent.status
      if (setupIntentStatus !== 'succeeded' && setupIntentStatus !== 'processing') {
        showToast({ variant: 'error', title: 'Impossible d’enregistrer le mandat', message: 'La confirmation n’a pas abouti. Réessayez.' })
        return
      }

      // Le serveur relit lui-même le SetupIntent chez Stripe : seul son identifiant lui est transmis.
      const token = await getAccessToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/payment-method/setup-intents/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ setupIntentId: confirmed.setupIntent.id })
      })
      const body = await readJson(response)
      const payment = response.ok ? readPaymentMethod(body) : undefined
      if (payment !== undefined && payment !== null) {
        onComplete(payment)
        showToast({ variant: 'success', title: 'Mandat bancaire enregistré' })
        return
      }

      const code = errorCode(body)
      if (code === 'SetupProcessing') {
        onProcessing()
        showToast({ variant: 'info', title: 'Validation en cours', message: 'Votre banque valide encore le mandat. Cette page se mettra à jour automatiquement.' })
        return
      }
      // Stripe a peut-être déjà validé le mandat : le webhook peut l'activer malgré cet échec.
      const notice = noticeForCode(code, 'La validation du mandat a échoué')
      showToast({ variant: notice.variant, title: notice.title, ...(notice.message === undefined ? {} : { message: notice.message }) })
      onRefresh()
    } catch (error) {
      // Stripe.js lève des IntegrationError (paramètres de confirmSetup incomplets…) avant tout appel
      // réseau : sans cette trace, l'utilisateur ne voit qu'un message générique et rien n'est diagnostiquable.
      console.error('Confirmation du mandat SEPA impossible', error instanceof Error ? `${error.name}: ${error.message}` : 'erreur inconnue')
      showToast({ variant: 'error', title: 'Impossible d’enregistrer le mandat', message: 'Une erreur est survenue. Réessayez.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 flex max-w-xl flex-col gap-4">
      <PaymentElement options={{ layout: 'tabs', fields: { billingDetails: { name: 'never', email: 'never', address: 'never' } } }} />
      <div className="flex flex-col-reverse gap-3 sm:flex-row">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving} className="w-full sm:w-auto">
          Annuler
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={saving || stripe === null || elements === null} className="w-full sm:w-auto">
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" />Enregistrement…</> : 'Enregistrer le mandat'}
        </Button>
      </div>
    </div>
  )
}

export function SepaPaymentMethod({ email, billingDetails, getAccessToken }: Props) {
  const { showToast } = useToast()
  const [payment, setPayment] = useState<PaymentMethod | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [validating, setValidating] = useState<{ baseline: string } | null>(null)

  // La page parente recrée `getAccessToken` à chaque rendu : on la lit via une ref pour que
  // le chargement ne se relance pas à chaque frappe dans les autres sections du compte.
  const tokenSource = useRef(getAccessToken)
  useEffect(() => {
    tokenSource.current = getAccessToken
  }, [getAccessToken])
  const readToken = useCallback(() => tokenSource.current(), [])

  const fetchPayment = useCallback(async (): Promise<PaymentMethod | null | undefined> => {
    try {
      const token = await readToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/payment-method`, { headers: { authorization: `Bearer ${token}` } })
      if (!response.ok) return undefined
      const next = readPaymentMethod(await readJson(response))
      if (next !== undefined) setPayment(next)
      return next
    } catch {
      return undefined
    }
  }, [readToken])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchPayment().then((result) => {
        if (result === undefined) showToast({ variant: 'error', title: 'Erreur', message: 'Impossible de charger le moyen de paiement.' })
        setLoading(false)
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchPayment, showToast])

  // Attente d'un mandat que la banque valide encore : le webhook Stripe l'activera côté serveur.
  useEffect(() => {
    if (validating === null) return
    let polls = 0
    const timer = window.setInterval(() => {
      polls += 1
      void fetchPayment().then((result) => {
        const changed = result !== undefined && JSON.stringify(result) !== validating.baseline
        if (changed || polls >= MAX_POLLS) {
          setValidating(null)
          if (!changed) showToast({ variant: 'warning', title: 'Validation plus longue que prévu', message: 'Actualisez la page dans quelques instants.' })
        }
      })
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [validating, fetchPayment, showToast])

  function startValidating() {
    setClientSecret(null)
    setValidating({ baseline: JSON.stringify(payment) })
  }

  async function begin() {
    if (stripePromise === null || billingDetails === null) return
    setStarting(true)
    try {
      const token = await readToken()
      const response = await fetch(`${apiUrl}/api/v1/merchants/me/payment-method/setup-intents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` }
      })
      const body = await readJson(response)
      if (response.ok && typeof body === 'object' && body !== null && 'clientSecret' in body && typeof body.clientSecret === 'string') {
        setClientSecret(body.clientSecret)
        return
      }
      const code = errorCode(body)
      const notice = noticeForCode(code, 'Impossible de commencer la configuration')
      showToast({ variant: notice.variant, title: notice.title, ...(notice.message === undefined ? {} : { message: notice.message }) })
      if (code === 'SetupAlreadyCompleted') void fetchPayment()
      if (code === 'SetupProcessing') startValidating()
    } catch {
      showToast({ variant: 'error', title: 'Impossible de commencer la configuration', message: 'Une erreur est survenue. Réessayez.' })
    } finally {
      setStarting(false)
    }
  }

  const canStart = !starting && validating === null && billingDetails !== null
  const isActive = payment?.status === 'active'
  const startLabel = isActive ? 'Remplacer le compte bancaire' : payment?.status === 'invalid' ? 'Remplacer le compte bancaire' : 'Ajouter un compte bancaire'

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-md md:p-6">
      <h2 className="text-body-sm font-semibold uppercase tracking-wide text-stone-400">Moyen de paiement</h2>
      <p className="mt-1 text-body-sm text-stone-600">
        Les notifications relatives à vos prélèvements seront envoyées à {email || 'votre adresse e-mail de compte'}.
      </p>

      {loading ? (
        <div className="mt-4"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>
      ) : stripePromise === null ? (
        <p className="mt-4 text-body-sm text-accent-800">La configuration des paiements n’est pas disponible pour le moment.</p>
      ) : clientSecret !== null && billingDetails !== null ? (
        <Elements stripe={stripePromise} options={{ clientSecret, appearance, fonts: elementsFonts, locale: 'fr' }}>
          <SetupForm
            billingDetails={billingDetails}
            getAccessToken={readToken}
            onComplete={(next) => { setPayment(next); setClientSecret(null) }}
            onProcessing={startValidating}
            onRefresh={() => { setClientSecret(null); void fetchPayment() }}
            onCancel={() => setClientSecret(null)}
          />
        </Elements>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {isActive && (
            <>
              <p className="text-body-sm text-stone-700">
                <span className="font-semibold">{payment.bankName ?? 'Compte bancaire'}</span>
                {payment.country === null ? '' : ` · ${payment.country}`}
                {payment.last4 === null ? '' : ` · •••• ${payment.last4}`}
              </p>
              <span className="w-fit rounded-full bg-primary-100 px-3 py-1 text-label font-semibold text-primary-800">Actif</span>
            </>
          )}
          {payment?.status === 'invalid' && (
            <p className="rounded-md bg-red-100 px-3 py-2 text-body-sm text-red-700">
              Votre mandat n’est plus valide. Remplacez votre compte bancaire.
            </p>
          )}
          {validating !== null && (
            <p role="status" className="flex items-center gap-2 rounded-md bg-info-100 px-3 py-2 text-body-sm text-info-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              Validation du mandat en cours…
            </p>
          )}
          {billingDetails === null && (
            <p className="text-body-sm text-stone-500">
              Enregistrez vos informations légales ci-dessus pour {isActive ? 'remplacer' : 'ajouter'} un compte bancaire.
            </p>
          )}
          <Button type="button" variant={isActive ? 'secondary' : 'primary'} onClick={() => void begin()} disabled={!canStart} className="w-full sm:w-auto sm:self-start">
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
            {startLabel}
          </Button>
        </div>
      )}
    </section>
  )
}
