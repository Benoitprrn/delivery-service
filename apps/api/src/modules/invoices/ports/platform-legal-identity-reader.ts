import type { MandateSeller } from './mandate-pdf-renderer.js'
export interface PlatformLegalIdentityReader { findPlatformLegalIdentity(): Promise<MandateSeller | null> }
