export class DriverSignupConflictError extends Error { public constructor() { super('An account with these details already exists'); this.name = 'AccountAlreadyExistsError' } }
export class DriverSignupFinalizingError extends Error { public constructor() { super('Account creation is being finalized'); this.name = 'DriverSignupFinalizingError' } }
export class DriverProvisioningError extends Error { public constructor() { super('Driver profile provisioning failed'); this.name = 'DriverProvisioningError' } }
