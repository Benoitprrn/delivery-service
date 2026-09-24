export interface DriverProfileReader { findDriverProfile(driverId: string): Promise<{ firstName: string; lastName: string } | null> }
