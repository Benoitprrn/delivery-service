import type { Zone } from '../domain/zone.js'
import type { LatLng } from '../../geocoding/public.js'

export type FindContainingPointResult =
  | { kind: 'none' }
  | { kind: 'one'; zone: Zone }
  | { kind: 'multiple'; zones: Zone[] }

export interface ZoneRepository {
  findById(id: string): Promise<Zone | null>
  findContainingPoint(point: LatLng): Promise<FindContainingPointResult>
}
