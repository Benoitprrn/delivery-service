import type { Metadata } from 'next'
import { DM_Sans } from 'next/font/google'
import { ToastProvider } from '@/components/toast-provider'
import './globals.css'

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans'
})

export const metadata: Metadata = {
  title: 'Terminus Livraison',
  description: 'Espace commerçant — service de livraison last-mile Bourg-en-Bresse'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={dmSans.variable}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
