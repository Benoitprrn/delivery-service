import { z } from 'zod'

export const driverAvailabilityBodySchema = z.object({ available: z.boolean() }).strict()

export const driverLocationBodySchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    recordedAt: z.string().datetime({ offset: true }).transform((value) => new Date(value))
  })
  .strict()
