'use client'

import { useEffect } from 'react'
import L from 'leaflet'
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

// Bourg-en-Bresse — pilote unique, cf. CLAUDE.md racine. Utilisé comme
// centre par défaut tant qu'aucune position livreur n'est connue.
const DEFAULT_CENTER: [number, number] = [46.2058, 5.2255]
const DEFAULT_ZOOM = 13
const FOLLOW_ZOOM = 15

function makeDotIcon(color: string, size = 32): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

// Bleu, cohérent avec le marqueur "livreur" déjà utilisé côté app mobile
// (apps/mobile/lib/colors.ts BLUE_500).
const driverIcon = makeDotIcon('#3B82F6')

export type TrackingMapPoint = { lat: number; lng: number }

export type TrackingMapProps = {
  driverPosition: TrackingMapPoint | null
  // Commande livrée : on garde la dernière position connue affichée mais on
  // arrête de recentrer la carte dessus ("carte figée" du brief).
  frozen?: boolean
}

// Doit vivre à l'intérieur de <MapContainer> pour accéder à l'instance via
// useMap() — recentre sur la position livreur à chaque mise à jour, sauf
// une fois figée.
function FollowDriver({ driverPosition, frozen }: { driverPosition: TrackingMapPoint | null; frozen: boolean }) {
  const map = useMap()

  useEffect(() => {
    if (driverPosition === null || frozen) return
    map.setView([driverPosition.lat, driverPosition.lng], FOLLOW_ZOOM, { animate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverPosition?.lat, driverPosition?.lng, frozen])

  return null
}

// Pas de marqueur pickup/livraison ici, volontairement : le contrat public
// GET /orders/track/:token n'expose ni l'un ni l'autre (règle absolue —
// jamais de PII/adresse client, et l'adresse commerçant n'est pas non plus
// dans ce contrat). Seule la position du livreur est géographique ici.
export function TrackingMap({ driverPosition, frozen = false }: TrackingMapProps) {
  const initialCenter: [number, number] =
    driverPosition !== null ? [driverPosition.lat, driverPosition.lng] : DEFAULT_CENTER
  const initialZoom = driverPosition !== null ? FOLLOW_ZOOM : DEFAULT_ZOOM

  return (
    <div className="h-full w-full overflow-hidden">
      <MapContainer center={initialCenter} zoom={initialZoom} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {driverPosition !== null && <Marker position={[driverPosition.lat, driverPosition.lng]} icon={driverIcon} />}
        <FollowDriver driverPosition={driverPosition} frozen={frozen} />
      </MapContainer>
    </div>
  )
}
