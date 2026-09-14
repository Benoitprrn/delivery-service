export function distanceInMeters(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number }
): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
  const latitudeDelta = toRadians(destination.lat - origin.lat)
  const longitudeDelta = toRadians(destination.lng - origin.lng)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(origin.lat)) * Math.cos(toRadians(destination.lat)) * Math.sin(longitudeDelta / 2) ** 2

  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}
