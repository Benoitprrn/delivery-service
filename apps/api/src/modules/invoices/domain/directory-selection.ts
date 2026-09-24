export type FrenchDirectoryEntry = { identifier: string; isActive: boolean }
export type DirectoryResolution =
  | { status: 'ready'; electronicAddress: { scheme: string; value: string } }
  | { status: 'not_addressable' }
  | { status: 'ambiguous' }
  | { status: 'lookup_failed' }

export function selectBuyerDirectoryEntry(entries: FrenchDirectoryEntry[]): DirectoryResolution {
  const active = entries.filter((entry) => entry.isActive)
  if (active.length === 0) return { status: 'not_addressable' }
  if (active.length !== 1) return { status: 'ambiguous' }
  const entry = active[0]
  if (entry === undefined) return { status: 'not_addressable' }
  const separator = entry.identifier.indexOf(':')
  if (separator === -1) return { status: 'ambiguous' }
  return { status: 'ready', electronicAddress: { scheme: entry.identifier.slice(0, separator), value: entry.identifier.slice(separator + 1) } }
}
