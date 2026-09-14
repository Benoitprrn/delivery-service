import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge ne connaît que l'échelle de tailles par défaut de Tailwind
// (text-xs, text-sm, ...). Sans cette extension, nos tailles custom du
// design system Terrain (text-h1, text-body-sm, ...) ne sont pas reconnues
// comme des utilitaires de taille de police : tailwind-merge les traite
// alors comme un groupe générique en conflit avec text-{couleur}, et
// supprime silencieusement l'un des deux (ex. `text-body-sm text-primary-700`
// perdait `text-body-sm`).
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'h1', 'h2', 'h3', 'body-lg', 'body', 'body-sm'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
