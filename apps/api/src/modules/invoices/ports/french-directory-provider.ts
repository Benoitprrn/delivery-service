import type { FrenchDirectoryEntry } from '../domain/directory-selection.js'
export interface FrenchDirectoryProvider { lookupBySiren(siren: string): Promise<FrenchDirectoryEntry[]> }
