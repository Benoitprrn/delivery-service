import { z } from 'zod'

const frenchPhone = /^(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}$/

export const updateMerchantBodySchema = z
  .object({
    name: z.string().trim().min(1),
    phonePrimary: z.string().trim().regex(frenchPhone, 'Invalid French phone number'),
    phoneSecondary: z.string().trim().regex(frenchPhone, 'Invalid French phone number').nullable().optional(),
    address: z.string().trim().min(1)
  })
  .strict()

const postalAddressSchema = z.object({ line1: z.string().trim().min(1), line2: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null), postalCode: z.string().trim().min(1), city: z.string().trim().min(1), countryCode: z.string().trim().length(2).default('FR'), communeCode: z.string().trim().min(1).nullable().optional().transform((value) => value ?? null) }).strict()
export const sireneLookupBodySchema = z.object({ siret: z.string().trim().min(1) }).strict()
export const updateLegalInformationBodySchema = z.object({ siret: z.string().trim().min(1), legalName: z.string().trim().min(1), legalAddress: postalAddressSchema, billingAddress: postalAddressSchema.nullable().optional(), vatNumber: z.string().trim().min(1).nullable().optional() }).strict()
