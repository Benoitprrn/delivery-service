export type MandateTemplate = { version: number; text: string; textSha256: string }
export interface MandateTemplateRepository { findCurrent(): Promise<MandateTemplate | null> }
