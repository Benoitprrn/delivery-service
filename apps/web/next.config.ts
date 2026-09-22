import type { NextConfig } from 'next'

function originOf(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

// Stripe.js exige que ces origines soient autorisées (guide de sécurité Stripe, section CSP) :
// script-src/frame-src js.stripe.com + *.js.stripe.com, frame-src hooks.stripe.com,
// connect-src api.stripe.com, img-src *.stripe.com. Jamais `default-src *`.
function buildContentSecurityPolicy(isProduction: boolean): string {
  const apiOrigin = originOf(process.env.NEXT_PUBLIC_API_URL)
  const supabaseOrigin = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL)
  // socket.io (commandes, suivi) ouvre un WebSocket vers l'API.
  const apiWebSocket = apiOrigin === null ? null : apiOrigin.replace(/^http/, 'ws')
  const connectSources = [
    "'self'",
    apiOrigin,
    apiWebSocket,
    supabaseOrigin,
    'https://api.stripe.com',
    'https://api.opencagedata.com'
  ].filter((source): source is string => source !== null)
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Next.js injecte des scripts inline (payload RSC) ; `unsafe-eval` n'est requis que par le mode dev.
    'script-src': ["'self'", "'unsafe-inline'", ...(isProduction ? [] : ["'unsafe-eval'"]), 'https://js.stripe.com', 'https://*.js.stripe.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    // Tuiles OpenStreetMap, logos (Supabase Storage) et ressources Stripe.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': connectSources,
    'frame-src': ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  }
  return Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ')
}

const isProduction = process.env.NODE_ENV === 'production'

const nextConfig: NextConfig = {
  // En production la CSP est appliquée. En développement elle reste en « report-only » :
  // les violations apparaissent dans la console sans jamais bloquer le rechargement à chaud.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: isProduction ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only',
            value: buildContentSecurityPolicy(isProduction)
          }
        ]
      }
    ]
  },

  // Autorise le navigateur Chrome OS (Chromebook/Crostini) à atteindre le
  // serveur de dev Next.js via l'IP de la VM Linux plutôt que localhost —
  // sans ça, Next.js bloque les requêtes internes (HMR, assets) dont l'Origin
  // ne correspond pas à un host connu. Next.js 16 utilise `allowedDevOrigins`
  // (le champ `allowedDevHosts` n'existe pas dans cette version).
  allowedDevOrigins: ['100.115.92.195'],

  // Leaflet (via react-leaflet, /merchant/new) mute et détruit son conteneur
  // DOM de façon impérative (map.remove() nettoie panes/handlers). Le double
  // montage volontaire de Strict Mode en dev exécute l'effet de montage une
  // seconde fois sur un Map déjà démonté par le nettoyage du premier passage
  // — TileLayer tente alors d'attacher sa pane à un conteneur déjà détruit
  // ("Cannot read properties of undefined (reading 'appendChild')"). N'affecte
  // que le dev server (Strict Mode ne double-invoque pas en production).
  reactStrictMode: false,

  // Next 16 active par défaut un canal de débogage React expérimental dans
  // `next dev`. Lors d'une navigation qui redirige après connexion, Next peut
  // recevoir la fin du canal avant un dernier chunk puis tente d'écrire et de
  // fermer deux fois le WritableStream. Cela produit les faux positifs
  // "Cannot write/close a CLOSED writable stream" dans hot-reloader-app.tsx.
  // Le canal ne sert qu'aux outils de débogage de Next et n'est pas requis par
  // l'application ; le désactiver n'affecte donc pas le comportement en prod.
  experimental: {
    reactDebugChannel: false
  }
}

export default nextConfig
