import { z } from 'zod'

export function normalizeFrenchPhone(value: string): string {
  const compact = value.trim().replace(/[\s.-]/g, '')
  const national = /^0([1-9]\d{8})$/.exec(compact)
  const international = /^\+33([1-9]\d{8})$/.exec(compact)
  const digits = national?.[1] ?? international?.[1]
  if (digits === undefined) throw new Error('Invalid French phone number')
  return `+33${digits}`
}

export const driverSignupBodySchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().transform((value, context) => {
    try { return normalizeFrenchPhone(value) } catch { context.addIssue({ code: 'custom', message: 'Invalid French phone number' }); return z.NEVER }
  }),
  // No `passwordConfirmation`: unlike merchant-signup's web form (two visible
  // password fields, a genuine typo safety net), the driver-signup screen has
  // a single password field — a confirmation copied from that same value by
  // the client would always trivially match, so it would verify nothing.
  password: z.string().min(8).max(72).regex(/[A-Z]/, 'Password must contain an uppercase letter').regex(/[a-z]/, 'Password must contain a lowercase letter').regex(/[^A-Za-z0-9]/, 'Password must contain a special character'),
  termsAccepted: z.literal(true)
}).strict()

export const driverAvailabilityBodySchema = z
  .object({
    available: z.boolean(),
    // Accepted temporarily for the pre-P1 mobile client, but deliberately
    // ignored by the availability use case: location has its own endpoint.
    lat: z.number().finite().min(-90).max(90).optional(),
    lng: z.number().finite().min(-180).max(180).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      context.addIssue({ code: 'custom', message: 'Latitude and longitude must be provided together', path: ['lat'] })
    }
  })

export const driverPushTokenBodySchema = z.object({ token: z.string().min(1).max(4_096) }).strict()

export const driverLocationBodySchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    recordedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value))
  })
  .strict()

const draftText = z.string().trim().max(500).nullable()
export const driverCompanyProfileBodySchema = z.object({ firstName: draftText, lastName: draftText, phone: draftText, legalForm: draftText, professionalName: draftText, siret: draftText, legalAddress: z.object({ line1: draftText, postalCode: draftText, city: draftText }).strict(), vatNumber: draftText, vatRegime: z.enum(['assujetti', 'franchise_en_base', 'exonere']).nullable() }).strict()
