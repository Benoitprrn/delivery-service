'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ClipboardList, Menu, PackagePlus, PanelLeftClose, PanelLeftOpen, Settings, X, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SignOutButton } from '@/components/sign-out-button'

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { href: '/merchant/new', label: 'Demander une livraison', icon: PackagePlus },
  { href: '/merchant/orders', label: 'Mes Livraisons', icon: ClipboardList },
  { href: '/merchant/account', label: 'Mon Compte', icon: Settings }
]

type SidebarProps = {
  email: string
}

export function Sidebar({ email }: SidebarProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <>
      {/* Barre mobile — seul point d'entrée pour ouvrir la sidebar sous md,
          où elle est masquée par défaut et s'ouvre en overlay. */}
      <div className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Ouvrir le menu"
          className="flex h-10 w-10 items-center justify-center rounded-md text-stone-600 transition-colors duration-fast ease-default hover:bg-stone-100"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-h3 font-bold text-primary-600">Terminus</span>
      </div>

      {mobileOpen && (
        <div
          role="presentation"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-overlay bg-stone-900/40 md:hidden"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-modal flex h-screen w-64 flex-col border-r border-border bg-surface transition-all duration-base ease-default',
          'md:relative md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'md:w-16' : 'md:w-60'
        )}
      >
        <div className={cn('flex items-center justify-between gap-2 border-b border-border px-4 py-4', collapsed && 'md:justify-center md:px-2')}>
          <span className={cn('text-h3 font-bold text-primary-600', collapsed && 'md:hidden')}>Terminus</span>

          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Étendre la barre latérale' : 'Réduire la barre latérale'}
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors duration-fast ease-default hover:bg-stone-100 md:flex"
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </button>

          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Fermer le menu"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors duration-fast ease-default hover:bg-stone-100 md:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href)
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                title={item.label}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-body-sm font-medium transition-colors duration-fast ease-default',
                  collapsed && 'md:justify-center md:px-0',
                  isActive ? 'bg-primary-50 text-primary-700' : 'text-stone-600 hover:bg-stone-100'
                )}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className={cn(collapsed && 'md:hidden')}>{item.label}</span>
              </Link>
            )
          })}
        </nav>

        <div className="border-t border-border p-3">
          <p className={cn('mb-2 truncate px-3 text-body-sm text-stone-500', collapsed && 'md:hidden')}>{email}</p>
          <SignOutButton collapsed={collapsed} onBeforeSignOut={() => setMobileOpen(false)} />
        </div>
      </aside>
    </>
  )
}
