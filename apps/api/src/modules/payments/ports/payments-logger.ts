export interface PaymentsLogger {
  debug(object: Record<string, unknown>, message: string): void
  info(object: Record<string, unknown>, message: string): void
  warn(object: Record<string, unknown>, message: string): void
  error(object: Record<string, unknown>, message: string): void
}

export const noopPaymentsLogger: PaymentsLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
