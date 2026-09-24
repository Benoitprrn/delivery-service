import { z } from 'zod'

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

const frenchPhone = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/
const postalAddressSchema = z.object({ line1: z.string().trim().min(1), line2: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null), postalCode: z.string().trim().regex(/^\d{5}$/), city: z.string().trim().min(1), countryCode: z.string().trim().length(2).default('FR'), communeCode: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null) }).strict()
export const updateDriverProfileBodySchema = z.object({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1), phone: z.string().trim().regex(frenchPhone) }).strict()
export const updateDriverLegalInformationBodySchema = z.object({ professionalName: z.string().trim().min(1), siret: z.string().trim().min(1), legalAddress: postalAddressSchema, billingAddress: postalAddressSchema.nullable().optional(), vatNumber: z.string().trim().regex(/^FR[A-Z0-9]{2}\d{9}$/).nullable().optional(), vatRegime: z.enum(['assujetti', 'franchise_en_base', 'exonere']).nullable().optional(), legalForm: z.string().trim().min(1).nullable().optional() }).strict()
