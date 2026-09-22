import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)
  const { pathname } = request.nextUrl

  if ((pathname.startsWith('/merchant') || pathname.startsWith('/admin')) && user === null) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  if ((pathname === '/login' || pathname === '/signup') && user !== null) {
    // Un opérateur (rôle `admin` dans les métadonnées Supabase) arrive sur la page d'administration des règlements.
    const target = user.app_metadata?.role === 'admin' ? '/admin/settlements' : '/merchant/new'
    return NextResponse.redirect(new URL(target, request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']
}
