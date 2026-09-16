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
