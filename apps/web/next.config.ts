import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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
  reactStrictMode: false
}

export default nextConfig
