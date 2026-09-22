export class SettlementDomainError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
  }
}

export class InvalidAmountError extends SettlementDomainError {
  public constructor(message = 'Amount must be a non-negative safe integer') { super('INVALID_AMOUNT', message) }
}
export class DuplicateSettleableOrderError extends SettlementDomainError {
  public constructor() { super('DUPLICATE_SETTLEABLE_ORDER', 'A settleable order can appear only once in a period ledger') }
}
export class NotSettleableOrderError extends SettlementDomainError {
  public constructor() { super('NOT_SETTLEABLE_ORDER', 'Order ids, parties, and final status must be settleable') }
}
export class InvalidLocalDateError extends SettlementDomainError {
  public constructor(message = 'Date must be a valid YYYY-MM-DD local date') { super('INVALID_LOCAL_DATE', message) }
}
export class NotAMondayError extends SettlementDomainError {
  public constructor() { super('NOT_A_MONDAY', 'Closing date must be a Monday') }
}
export class InvalidBusinessDaysError extends SettlementDomainError {
  public constructor() { super('INVALID_BUSINESS_DAYS', 'Business-day count must be a non-negative safe integer') }
}
export class InvalidIdempotencyKeyInputError extends SettlementDomainError {
  public constructor() { super('INVALID_IDEMPOTENCY_KEY_INPUT', 'Ids must be non-empty and contain no colon; try number must be at least one') }
}
export class RestaurantDefaultReversalForbiddenError extends SettlementDomainError {
  public constructor() { super('RESTAURANT_DEFAULT_REVERSAL_FORBIDDEN', 'Restaurant default or SEPA dispute cannot reverse a driver transfer') }
}
export class InvalidReversalCategoryError extends SettlementDomainError {
  public constructor() { super('INVALID_REVERSAL_CATEGORY', 'Reversal category is invalid') }
}
export class ReversalAmountExceededError extends SettlementDomainError {
  public constructor() { super('REVERSAL_AMOUNT_EXCEEDED', 'Requested reversal exceeds the remaining transfer amount') }
}
export class InvalidStatementStatusTransitionError extends SettlementDomainError {
  public constructor() { super('INVALID_STATEMENT_STATUS_TRANSITION', 'A paid statement cannot return to a non-paid status') }
}
export class InvalidReversalReasonError extends SettlementDomainError {
  public constructor(message = 'The reversal reason code is not allowed for this category') { super('INVALID_REVERSAL_REASON', message) }
}
export class ReversalDecisionIncompleteError extends SettlementDomainError {
  public constructor(message = 'A reversal needs a non blank reason, a decision reference and a positive integer amount') { super('REVERSAL_DECISION_INCOMPLETE', message) }
}
export class ReversalApproverError extends SettlementDomainError {
  public constructor() { super('REVERSAL_APPROVER', 'The approver must be a different person than the requester') }
}
export class ReversalLedgerMismatchError extends SettlementDomainError {
  public constructor() { super('REVERSAL_LEDGER_MISMATCH', 'Stripe reports a different reversed amount than the ledger: reconcile before reversing') }
}
export class InvalidRetryAttemptError extends SettlementDomainError {
  public constructor(message = 'Retry attempt numbers must be unique positive safe integers') { super('INVALID_RETRY_ATTEMPT', message) }
}
