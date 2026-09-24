import { describe, expect, it } from 'vitest'
import { selectBuyerDirectoryEntry } from '../../src/modules/invoices/domain/directory-selection.js'

describe('selectBuyerDirectoryEntry', () => {
  it('selects one active entry by splitting only the first colon', () => expect(selectBuyerDirectoryEntry([{ identifier: '0225:853322915:opaque', isActive: true }])).toEqual({ status: 'ready', electronicAddress: { scheme: '0225', value: '853322915:opaque' } }))
  it('returns not addressable for no entries or no active entries', () => { expect(selectBuyerDirectoryEntry([])).toEqual({ status: 'not_addressable' }); expect(selectBuyerDirectoryEntry([{ identifier: 'a:b', isActive: false }, { identifier: 'c:d', isActive: false }])).toEqual({ status: 'not_addressable' }) })
  it('returns ambiguous for multiple active entries or malformed identifiers', () => { expect(selectBuyerDirectoryEntry([{ identifier: 'a:b', isActive: true }, { identifier: 'c:d', isActive: true }])).toEqual({ status: 'ambiguous' }); expect(selectBuyerDirectoryEntry([{ identifier: 'no-separator', isActive: true }])).toEqual({ status: 'ambiguous' }) })
})
