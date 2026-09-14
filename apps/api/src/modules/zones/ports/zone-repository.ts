import type { Zone } from '../domain/zone.js'

export interface ZoneRepository {
  findById(id: string): Promise<Zone | null>
}
