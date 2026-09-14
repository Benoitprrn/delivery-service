'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'

type SignOutButtonProps = {
  // Icône seule à partir de md quand la sidebar est réduite — le libellé
  // reste toujours visible en dessous de md (la sidebar y est en overlay,
  // jamais réduite).
  collapsed?: boolean
  // Appelé immédiatement au clic, avant l'appel réseau — sert à fermer le
  // menu mobile tout de suite, comme le font les liens de navigation.
  onBeforeSignOut?: () => void
}

export function SignOutButton({ collapsed = false, onBeforeSignOut }: SignOutButtonProps) {
  const router = useRouter()
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleSignOut() {
    onBeforeSignOut?.()
    setIsSigningOut(true)
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
    // Un seul refresh : le proxy (middleware) redirige déjà /merchant/* vers
    // /login dès qu'il ne trouve plus d'utilisateur — pas besoin d'un
    // router.push() en plus, qui court-circuitait cette logique et causait
    // des requêtes RSC concurrentes (erreur de stream Turbopack en dev).
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isSigningOut}
      title="Se déconnecter"
      className={cn(
        // Même recette que les liens de navigation de la sidebar, pour un
        // comportement et un rendu identiques aux onglets.
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-body-sm font-medium text-stone-600 transition-colors duration-fast ease-default hover:bg-stone-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        collapsed && 'md:justify-center md:px-0'
      )}
    >
      <LogOut className="h-5 w-5 shrink-0" />
      <span className={cn(collapsed && 'md:hidden')}>{isSigningOut ? 'Déconnexion…' : 'Se déconnecter'}</span>
    </button>
  )
}
