import { DispatchPlannerUnavailableError } from '../domain/errors.js'
import type { DispatchPlanStep, DispatchPlanner, DispatchPlannerInput, DispatchShipment } from '../ports/dispatch-planner.js'

type VroomStep = {
  type: string
  location: [number, number]
  arrival: number
  duration: number
  service: number
  waiting_time: number
  id?: number
}

type VroomResponse = {
  unassigned?: unknown[]
  routes?: { steps?: VroomStep[] }[]
}

export class VroomDispatchPlanner implements DispatchPlanner {
  public constructor(private readonly vroomUrl: string) {}

  public async checkFeasibility(input: DispatchPlannerInput): Promise<{ feasible: true; steps: DispatchPlanStep[] } | { feasible: false }> {
    const shipments = [...input.existingShipments, input.candidateShipment]
    const shipmentIds = new Map<number, string>()
    const vroomShipments = shipments.map((shipment, index) => {
      const id = index + 1
      shipmentIds.set(id, shipment.orderId)
      return this.toVroomShipment(id, shipment)
    })

    let response: Response
    try {
      response = await fetch(new URL('/', this.vroomUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          vehicles: [{
            id: 1,
            // Sans `profile`, VROOM utilise "car" par défaut — absent de
            // notre config.yml (seul le profil vélo y est déclaré), ce qui
            // fait échouer CHAQUE requête avec "Invalid profile: car" (HTTP
            // 400), classé à tort comme DispatchPlannerUnavailableError par
            // le bloc catch ci-dessous (VROOM répond, mais à une requête
            // invalide — pas une indisponibilité). Vérifié en direct contre
            // un vrai VROOM local.
            profile: 'bike',
            capacity: [2],
            speed_factor: 1.0,
            start: [input.driver.location.lng, input.driver.location.lat],
            end: [input.driver.location.lng, input.driver.location.lat]
          }],
          shipments: vroomShipments
        }),
        signal: AbortSignal.timeout(5_000)
      })
    } catch (error) {
      throw new DispatchPlannerUnavailableError(`VROOM request failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    if (!response.ok) {
      throw new DispatchPlannerUnavailableError(`VROOM returned HTTP ${response.status}`)
    }

    let payload: VroomResponse
    try {
      payload = await response.json() as VroomResponse
    } catch {
      throw new DispatchPlannerUnavailableError('VROOM returned invalid JSON')
    }
    if ((payload.unassigned?.length ?? 0) > 0) return { feasible: false }

    const steps = payload.routes?.[0]?.steps
    if (steps === undefined) {
      throw new DispatchPlannerUnavailableError('VROOM response did not contain a route')
    }
    return {
      feasible: true,
      steps: steps.map((step) => {
        const mappedStep = {
          type: step.type,
          location: step.location,
          arrival: step.arrival,
          duration: step.duration,
          service: step.service,
          waitingTime: step.waiting_time
        }
        const shipmentId = step.id === undefined ? undefined : shipmentIds.get(step.id)
        return shipmentId === undefined ? mappedStep : { ...mappedStep, shipmentId }
      })
    }
  }

  private toVroomShipment(id: number, shipment: DispatchShipment): object {
    const pickupAt = Math.floor(shipment.pickupScheduledAt.getTime() / 1_000)
    const deliveryAt = Math.floor(shipment.deliveryWindowStart.getTime() / 1_000)
    return {
      // VROOM exige un `id` sur chaque sous-objet pickup/delivery (pas
      // seulement au niveau du shipment) — vérifié en direct, requête
      // rejetée avec "Invalid or missing id for pickup" sinon. Le même id
      // que le shipment fonctionne (VROOM le renvoie tel quel dans les
      // steps de la réponse, utilisé pour la corrélation shipmentId
      // ci-dessus).
      pickup: {
        id,
        location: [shipment.pickupLocation.lng, shipment.pickupLocation.lat],
        service: 60,
        time_windows: [[pickupAt, pickupAt]]
      },
      delivery: {
        id,
        location: [shipment.deliveryLocation.lng, shipment.deliveryLocation.lat],
        service: 60,
        time_windows: [[deliveryAt, deliveryAt + 600]]
      }
    }
  }
}
