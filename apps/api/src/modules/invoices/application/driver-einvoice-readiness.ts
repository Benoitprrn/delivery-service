export interface DriverEInvoiceReadinessReader { hasVerifiedMandate(driverId: string): Promise<boolean> }
/** Used solely by the submission worker, never by marketplace/order acceptance. */
export class DriverEInvoiceReadiness { public constructor(private readonly reader: DriverEInvoiceReadinessReader) {} public isReady(driverId: string): Promise<boolean> { return this.reader.hasVerifiedMandate(driverId) } }
