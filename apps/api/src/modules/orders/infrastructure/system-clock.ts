import type { Clock } from '../ports/clock.js'

export class SystemClock implements Clock {
  public now(): Date {
    return new Date()
  }
}
