export interface DriverCapacityWriter {
  increment(driverId: string): Promise<void>
  decrement(driverId: string): Promise<void>
}
