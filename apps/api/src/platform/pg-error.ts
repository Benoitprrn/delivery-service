export const PG_FOREIGN_KEY_VIOLATION = '23503'
export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error
    return typeof code === 'string' ? code : undefined
  }

  return undefined
}
