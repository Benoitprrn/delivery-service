export type PickupSchedule =
  | { mode: 'asap' }
  | { mode: 'delay'; delayMinutes: number }
  | { mode: 'scheduled'; at: Date }

export class PastPickupScheduleError extends Error {
  public constructor(message = 'Pickup cannot be scheduled in the past') {
    super(message)
    this.name = 'PastPickupScheduleError'
  }
}

export function resolvePickupScheduledAt(schedule: PickupSchedule, now: Date): Date {
  const resolved = schedule.mode === 'asap'
    ? now
    : schedule.mode === 'delay'
      ? new Date(now.getTime() + schedule.delayMinutes * 60_000)
      : schedule.at

  if (resolved.getTime() < now.getTime()) {
    throw new PastPickupScheduleError()
  }
  return resolved
}
