import { z } from 'zod'

const frenchPhone = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/

export const updateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1),
    phoneLandline: z.string().trim().regex(frenchPhone, 'Invalid French phone number').nullable(),
    phoneMobile: z.string().trim().regex(frenchPhone, 'Invalid French phone number').nullable(),
    logoUrl: z.string().url().nullable(),
    address: z.string().trim().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.phoneLandline === null && value.phoneMobile === null) {
      context.addIssue({ code: 'custom', message: 'At least one phone number is required', path: ['phoneLandline'] })
    }
  })
