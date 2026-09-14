import type { Driver } from '../domain/driver.js'

export interface DriverRepository {
  findById(id: string): Promise<Driver | null>
}
