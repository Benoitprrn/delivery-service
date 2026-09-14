'use client'

import { useEffect } from 'react'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

export type GeoJsonLineString = {
  type: 'LineString'
  coordinates: [number, number][] // [lng, lat], comme renvoyé par OSRM
}

export type DeliveryMapPoint = { lat: number; lng: number }

export type DeliveryMapProps = {
  pickup: DeliveryMapPoint
  delivery?: DeliveryMapPoint | undefined
  geometry?: GeoJsonLineString | undefined
  distanceLabel?: string | undefined
  durationLabel?: string | undefined
  priceLabel?: string | undefined
}

function makeDotIcon(color: string, size = 32): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

const pickupIcon = makeDotIcon('#059669')
const deliveryIcon = makeDotIcon('#DC2626')

// Doit vivre à l'intérieur de <MapContainer> pour accéder à l'instance via
// useMap() — recentre/zoome automatiquement sur les points affichés.
function FitBounds({ pickup, delivery, geometry }: Pick<DeliveryMapProps, 'pickup' | 'delivery' | 'geometry'>) {
  const map = useMap()

  useEffect(() => {
    const points: [number, number][] = [[pickup.lat, pickup.lng]]
    if (delivery !== undefined) {
      points.push([delivery.lat, delivery.lng])
    }
    if (geometry !== undefined) {
      for (const [lng, lat] of geometry.coordinates) {
        points.push([lat, lng])
      }
    }
    if (points.length === 1) {
      map.setView(points[0] as [number, number], 14)
      return
    }
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup.lat, pickup.lng, delivery?.lat, delivery?.lng, geometry])

  return null
}

export function DeliveryMap({ pickup, delivery, geometry, distanceLabel, durationLabel, priceLabel }: DeliveryMapProps) {
  const hasSummary = distanceLabel !== undefined && durationLabel !== undefined && priceLabel !== undefined

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapContainer center={[pickup.lat, pickup.lng]} zoom={14} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[pickup.lat, pickup.lng]} icon={pickupIcon} />
        {delivery !== undefined && <Marker position={[delivery.lat, delivery.lng]} icon={deliveryIcon} />}
        {geometry !== undefined && (
          <Polyline positions={geometry.coordinates.map(([lng, lat]) => [lat, lng])} pathOptions={{ color: '#059669', weight: 4 }} />
        )}
        <FitBounds pickup={pickup} delivery={delivery} geometry={geometry} />
      </MapContainer>

      {hasSummary && (
        <div className="absolute inset-x-3 bottom-3 z-10 rounded-lg border border-border bg-surface/95 px-4 py-2.5 text-body-sm font-semibold text-stone-800 shadow-md backdrop-blur-sm">
          {distanceLabel} · {durationLabel} · {priceLabel}
        </div>
      )}
    </div>
  )
}
