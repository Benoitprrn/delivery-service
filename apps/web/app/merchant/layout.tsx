import { redirect } from 'next/navigation'
import { Sidebar } from '@/components/sidebar'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user }
  } = await supabase.auth.getUser()

  // Filet de sécurité — le middleware protège déjà /merchant/*, mais un
  // Server Component ne doit jamais présumer qu'une session est valide.
  if (user === null) {
    redirect('/login')
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background md:flex-row">
      <Sidebar email={user.email ?? ''} />
      <main className="min-h-0 flex-1 overflow-hidden px-page-mobile py-6 md:px-page-desktop">{children}</main>
    </div>
  )
}
