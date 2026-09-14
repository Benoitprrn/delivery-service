import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)
  const { pathname } = request.nextUrl

  if (pathname.startsWith('/merchant') && user === null) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  if (pathname === '/login' && user !== null) {
    const merchantUrl = new URL('/merchant/new', request.url)
    return NextResponse.redirect(merchantUrl)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']
}
