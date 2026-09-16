export type DispatchLocation = { lat: number; lng: number }

export type DispatchShipment = {
  orderId: string
  pickupLocation: DispatchLocation
  deliveryLocation: DispatchLocation
  /** UTC instant used by VROOM as the fixed pickup time. */
  pickupScheduledAt: Date
  /** UTC instant at which the delivery time window starts. */
  deliveryWindowStart: Date
}

export type DispatchPlannerInput = {
  driver: { id: string; location: DispatchLocation }
  existingShipments: readonly DispatchShipment[]
  candidateShipment: DispatchShipment
}

export type DispatchPlanStep = {
  type: string
  location: [number, number]
  arrival: number
  duration: number
  service: number
  waitingTime: number
  shipmentId?: string
}

export type DispatchPlanner = {
  checkFeasibility(input: DispatchPlannerInput): Promise<{ feasible: true; steps: DispatchPlanStep[] } | { feasible: false }>
}
