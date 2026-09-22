'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AuthMapPlaceholder } from '@/components/auth-map-placeholder'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { apiUrl } from '@/lib/config'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_MIN_LENGTH = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export default function SignupPage() {
  const router = useRouter()

  const [merchantName, setMerchantName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')

  const [nameTouched, setNameTouched] = useState(false)
  const [emailTouched, setEmailTouched] = useState(false)
  const [passwordTouched, setPasswordTouched] = useState(false)
  const [confirmationTouched, setConfirmationTouched] = useState(false)

  const [error, setError] = useState<string | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const nameValid = merchantName.trim().length > 0
  const emailValid = EMAIL_REGEX.test(email.trim())
  const passwordValid = password.length >= PASSWORD_MIN_LENGTH
  const confirmationValid = passwordConfirmation.length > 0 && passwordConfirmation === password

  const canSubmit = nameValid && emailValid && passwordValid && confirmationValid && !isSubmitting

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNameTouched(true)
    setEmailTouched(true)
    setPasswordTouched(true)
    setConfirmationTouched(true)
    if (!canSubmit) return

    setError(undefined)
    setIsSubmitting(true)

    try {
      const response = await fetch(`${apiUrl}/api/v1/auth/merchant-signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          merchantName: merchantName.trim(),
          email: email.trim(),
          password,
          passwordConfirmation
        })
      })
      const body: unknown = await response.json()

      if (!response.ok) {
        const errorCode = isRecord(body) && typeof body.error === 'string' ? body.error : undefined
        throw new Error(signupErrorMessage(errorCode, response.status))
      }

      const supabase = createSupabaseBrowserClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      })
      if (signInError !== null) {
        throw new Error('Compte créé, mais la connexion automatique a échoué. Connectez-vous manuellement.')
      }

      // Comme sur /login : le middleware redirige déjà un utilisateur
      // authentifié vers son espace, un router.push() en plus créerait des
      // requêtes RSC concurrentes.
      router.refresh()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'La création du compte a échoué.')
      setIsSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-page-mobile py-8">
      <div className="w-full max-w-sm md:max-w-4xl">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md md:grid md:grid-cols-2">
          <div className="p-6 md:p-8">
            <div className="mb-6 flex flex-col items-center gap-1 text-center">
              <span className="text-h2 font-bold text-primary-600">Locadely</span>
              <h1 className="text-h3 font-semibold text-stone-800">Créez votre compte</h1>
            </div>

            <form onSubmit={handleSubmit} method="post" noValidate className="flex flex-col gap-4">
              <Input
                label="Nom du commerce"
                name="merchantName"
                autoComplete="organization"
                placeholder="Restaurant Le Terminus"
                value={merchantName}
                onChange={(event) => setMerchantName(event.target.value)}
                onBlur={() => setNameTouched(true)}
                error={nameTouched && !nameValid ? 'Le nom du commerce est requis' : undefined}
                required
              />

              <Input
                label="E-mail"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="vous@restaurant.fr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onBlur={() => setEmailTouched(true)}
                error={emailTouched && !emailValid ? 'Adresse email invalide' : undefined}
                required
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Mot de passe"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onBlur={() => setPasswordTouched(true)}
                  error={passwordTouched && !passwordValid ? `${PASSWORD_MIN_LENGTH} caractères minimum` : undefined}
                  required
                />
                <Input
                  label="Confirmez le mot de passe"
                  type="password"
                  name="passwordConfirmation"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={passwordConfirmation}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                  onBlur={() => setConfirmationTouched(true)}
                  error={confirmationTouched && !confirmationValid ? 'Les mots de passe ne correspondent pas' : undefined}
                  required
                />
              </div>

              {error !== undefined && (
                <p role="alert" className="rounded-md bg-red-100 px-3.5 py-2.5 text-body-sm text-red-700">
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" fullWidth disabled={!canSubmit} className="mt-2">
                {isSubmitting ? 'Création…' : 'Créer un compte'}
              </Button>

              <p className="text-center text-body-sm text-stone-500">
                Vous avez déjà un compte ?{' '}
                <Link href="/login" className="font-semibold text-primary-600 hover:text-primary-700">
                  Connectez-vous
                </Link>
              </p>
            </form>
          </div>

          <AuthMapPlaceholder />
        </div>

        <p className="mt-4 px-6 text-center text-label text-stone-400">
          En créant un compte, vous acceptez nos{' '}
          <a href="#" className="underline hover:text-stone-600">
            Conditions Générales d&apos;Utilisation
          </a>{' '}
          et notre{' '}
          <a href="#" className="underline hover:text-stone-600">
            Politique de confidentialité
          </a>
          .
        </p>
      </div>
    </main>
  )
}

function signupErrorMessage(errorCode: string | undefined, status: number): string {
  switch (errorCode) {
    case 'AccountAlreadyExistsError':
      return 'Un compte existe déjà avec cet e-mail.'
    case 'ValidationError':
      return 'Vérifiez les informations saisies.'
    case 'TooManyRequestsError':
      return 'Trop de tentatives, réessayez dans quelques instants.'
    case 'AuthProviderError':
      return "Le service d'authentification est momentanément indisponible."
    default:
      return status >= 500
        ? 'La création du compte a échoué, réessayez plus tard.'
        : 'La création du compte a échoué.'
  }
}
