export type ElectronicInvoicingStatus = 'available' | 'unavailable' | 'unknown'
export interface ElectronicInvoicingStatusReader { getStatus(merchantId: string): Promise<ElectronicInvoicingStatus> }
