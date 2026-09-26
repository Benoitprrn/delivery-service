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

export class MerchantOnboardingIncompleteError extends Error {
  public constructor(message = 'Merchant onboarding must be completed before creating orders or estimates') {
    super(message)
    this.name = 'MerchantOnboardingIncompleteError'
  }
}

export class CashOnDeliveryPaymentRequiredError extends Error {
  public constructor(message = 'Cash on delivery payment must be collected before completion') {
    super(message)
    this.name = 'CashOnDeliveryPaymentRequired'
  }
}

export class CashOnDeliveryAlreadyCollectedError extends Error {
  public constructor(message = 'Cash on delivery payment was already collected') {
    super(message)
    this.name = 'CashOnDeliveryAlreadyCollected'
  }
}

export class CashOnDeliveryNotRequiredError extends Error {
  public constructor(message = 'Order does not require cash on delivery') {
    super(message)
    this.name = 'CashOnDeliveryNotRequiredError'
  }
}

export class CardPaymentsNotReadyError extends Error {
  public constructor(message = 'Card payments must be active before creating a cash on delivery order') {
    super(message)
    this.name = 'CardPaymentsNotReady'
  }
}

export { PastPickupScheduleError } from './pickup-schedule.js'

export class MerchantPaymentSetupIncompleteError extends Error {
  public constructor(public readonly reason: 'sepa_not_configured' | 'legal_information_incomplete', message = 'The merchant must have an active SEPA mandate and complete legal information before creating an order') {
    super(message)
    this.name = 'MerchantPaymentSetupIncomplete'
  }
}

export class DriverPayoutAccountNotReadyError extends Error {
  public constructor(message = 'The driver payout account must be ready before taking deliveries') {
    super(message)
    this.name = 'DriverPayoutAccountNotReady'
  }
}

export class DriverInvoiceInformationNotReadyError extends Error {
  public constructor(message = 'The driver invoice information must be complete before taking deliveries') {
    super(message)
    this.name = 'DriverInvoiceInformationNotReady'
  }
}

export class DriverCompanyProfileNotReadyError extends Error {
  public constructor(message = 'The driver company profile must be complete before taking deliveries') {
    super(message)
    this.name = 'DriverCompanyProfileNotReady'
  }
}

export class DriverMandateNotReadyError extends Error {
  public constructor(message = 'The driver invoice mandate must be signed before taking deliveries') {
    super(message)
    this.name = 'DriverMandateNotReady'
  }
}
