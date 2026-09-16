export class DispatchOfferConflictError extends Error {
  public constructor(message = 'An active dispatch offer already exists for this driver') {
    super(message)
    this.name = 'DispatchOfferConflictError'
  }
}

export class DispatchOfferNotFoundError extends Error {
  public constructor(message = 'Dispatch offer was not found') {
    super(message)
    this.name = 'DispatchOfferNotFoundError'
  }
}

export class DispatchOfferAccessDeniedError extends Error {
  public constructor(message = 'Drivers can only access their own dispatch offers') {
    super(message)
    this.name = 'DispatchOfferAccessDeniedError'
  }
}

export class DispatchPlannerUnavailableError extends Error {
  public constructor(message = 'Dispatch planner is unavailable') {
    super(message)
    this.name = 'DispatchPlannerUnavailableError'
  }
}
