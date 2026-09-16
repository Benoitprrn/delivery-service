import type { Session, User } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { disconnectSocket } from './socket'
import { api } from './api'
import { supabase } from './supabase'

export type AuthRole = 'merchant' | 'driver' | 'admin'
type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

type AuthContextValue = {
  status: AuthStatus
  role: AuthRole | null
  user: User | null
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

function extractRole(session: Session | null): AuthRole | null {
  const role: unknown = session?.user.app_metadata?.role
  return role === 'merchant' || role === 'driver' || role === 'admin' ? role : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [role, setRole] = useState<AuthRole | null>(null)
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    let isMounted = true

    function applySession(session: Session | null) {
      if (!isMounted) return
      if (session === null) {
        // Déconnexion propre du socket dès que la session livreur tombe —
        // logout explicite ou expiration/401 remontée par lib/api.ts.
        disconnectSocket()
      }
      setRole(extractRole(session))
      setUser(session?.user ?? null)
      setStatus(session === null ? 'signedOut' : 'signedIn')
    }

    void supabase.auth.getSession().then(({ data }) => applySession(data.session))

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => applySession(session))

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      role,
      user,
      signOut: async () => {
        if (role === 'driver') {
          try {
            await api.disconnectDriver()
          } catch (error) {
            console.warn('[auth] Driver disconnect failed before sign-out', error)
          }
        }
        await supabase.auth.signOut()
      }
    }),
    [status, role, user]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
