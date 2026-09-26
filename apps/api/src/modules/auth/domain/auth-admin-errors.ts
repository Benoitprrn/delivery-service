export class AccountAlreadyExistsError extends Error {
  public constructor(message = 'An account with this email already exists') {
    super(message)
    this.name = 'AccountAlreadyExistsError'
  }
}

export class AuthProviderError extends Error {
  public constructor(message = 'The authentication provider is unavailable') {
    super(message)
    this.name = 'AuthProviderError'
  }
}

/** A request may have reached GoTrue; do not compensate until it is reconciled. */
export class AuthProviderUnknownOutcomeError extends AuthProviderError {}
