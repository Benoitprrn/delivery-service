export class OrderConflictError extends Error {
  public constructor(message = 'Order version or status conflicts with this operation') {
    super(message)
    this.name = 'OrderConflictError'
  }
}

export class OrderNotFoundError extends Error {
  public constructor(message = 'Order was not found') {
    super(message)
    this.name = 'OrderNotFoundError'
  }
}

export class OrderRouteAccessDeniedError extends Error {
  public constructor(message = 'Drivers can only access routes for orders in their zone') {
    super(message)
    this.name = 'OrderRouteAccessDeniedError'
  }
}

export class InvalidTransitionError extends Error {
  public constructor(message = 'Order status transition is not allowed') {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export class MerchantNotFoundError extends Error {
  public constructor(message = 'Merchant was not found') {
    super(message)
    this.name = 'MerchantNotFoundError'
  }
}

export class InvalidZoneAssignmentError extends Error {
  public constructor(message = 'Merchant or driver must belong to the order zone') {
    super(message)
    this.name = 'InvalidZoneAssignmentError'
  }
}

export class DeliveryOutsideZoneError extends Error {
  public constructor(message = "Delivery point is outside the merchant's zone radius") {
    super(message)
    this.name = 'DeliveryOutsideZoneError'
  }
}

export { PastPickupScheduleError } from './pickup-schedule.js'
