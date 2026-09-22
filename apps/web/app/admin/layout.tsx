import { redirect } from 'next/navigation'
import { SignOutButton } from '@/components/sign-out-button'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/** Back-office opérateur minimal (R80) : réservé au rôle `admin` (métadonnées Supabase) ; l'API revérifie le rôle sur chaque appel. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user === null) redirect('/login')
  if (user.app_metadata?.role !== 'admin') redirect('/merchant/orders')

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <span className="text-h3 font-bold text-primary-600">Locadely · Administration</span>
        <div className="flex items-center gap-4">
          <span className="text-body-sm text-stone-500">{user.email ?? ''}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="px-6 py-6">{children}</main>
    </div>
  )
}
