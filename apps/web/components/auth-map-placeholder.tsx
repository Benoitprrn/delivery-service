import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

// Partagé entre /signup et /login. Isolé dans son propre composant pour
// pouvoir être remplacé par la vraie carte (zone de livraison Bourg-en-Bresse)
// sans toucher aux formulaires.
export function AuthMapPlaceholder({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative hidden flex-col items-center justify-center gap-4 bg-primary-50 p-8 md:flex',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-100 text-primary-600">
        <MapPin className="h-8 w-8" />
      </div>
      <p className="max-w-[220px] text-center text-body-sm font-medium text-primary-800">
        Votre zone de livraison à Bourg-en-Bresse s&apos;affichera bientôt ici
      </p>
    </div>
  )
}
