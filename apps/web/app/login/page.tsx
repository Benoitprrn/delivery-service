'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AuthMapPlaceholder } from '@/components/auth-map-placeholder'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(undefined)
    setIsSubmitting(true)

    const supabase = createSupabaseBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError !== null) {
      setError('Email ou mot de passe incorrect.')
      setIsSubmitting(false)
      return
    }

    // Un seul refresh : le proxy (middleware) redirige déjà /login vers
    // /merchant/new dès qu'il trouve un utilisateur authentifié — pas besoin
    // d'un router.push() en plus, qui court-circuitait cette logique et
    // causait des requêtes RSC concurrentes (erreur de stream Turbopack en
    // dev : "Cannot write to a CLOSED writable stream").
    router.refresh()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-page-mobile py-8">
      <div className="w-full max-w-sm md:max-w-4xl">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-md md:grid md:grid-cols-2">
          <div className="p-6 md:p-8">
            <div className="mb-6 flex flex-col items-center gap-1 text-center">
              <span className="text-h2 font-bold text-primary-600">Locadely</span>
              <p className="text-body text-stone-500">Espace commerçant</p>
            </div>

            <h1 className="mb-6 text-h3 font-semibold text-stone-800">Se connecter</h1>

            {/* method="post" est un filet de sécurité : si le JS n'a pas encore
                hydraté et intercepte la soumission trop tard, le navigateur ne
                doit jamais faire un fallback GET qui mettrait le mot de passe
                dans l'URL (historique, logs serveur, referrer). */}
            <form onSubmit={handleSubmit} method="post" noValidate className="flex flex-col gap-4">
              <Input
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="vous@restaurant.fr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <Input
                label="Mot de passe"
                type="password"
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />

              {error !== undefined && (
                <p role="alert" className="rounded-md bg-red-100 px-3.5 py-2.5 text-body-sm text-red-700">
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" fullWidth disabled={isSubmitting} className="mt-2">
                {isSubmitting ? 'Connexion…' : 'Se connecter'}
              </Button>

              <p className="text-center text-body-sm text-stone-500">
                Vous n&apos;avez pas de compte ?{' '}
                <Link href="/signup" className="font-semibold text-primary-600 hover:text-primary-700">
                  Créez-en un
                </Link>
              </p>
            </form>
          </div>

          <AuthMapPlaceholder />
        </div>
      </div>
    </main>
  )
}
