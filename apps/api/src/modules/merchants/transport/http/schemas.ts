import { z } from 'zod'

const frenchPhone = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/

export const updateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1),
    phone: z.string().trim().regex(frenchPhone, 'Invalid French phone number'),
    address: z.string().trim().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180)
  })
  .strict()
