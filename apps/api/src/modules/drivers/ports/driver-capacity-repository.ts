export interface DriverCapacityRepository {
  increment(driverId: string): Promise<number>
  decrement(driverId: string): Promise<number>
  // null is significant: Valkey has no counter to trust yet.
  get(driverId: string): Promise<number | null>
  set(driverId: string, capacity: number): Promise<void>
}
