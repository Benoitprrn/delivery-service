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
export const updateLegalInformationBodySchema = z.object({ siret: z.string().trim().min(1), legalName: z.string().trim().min(1), legalAddress: postalAddressSchema, billingAddress: postalAddressSchema.nullable().optional(), vatNumber: z.string().trim().min(1).nullable().optional(), vatRegime: z.enum(['assujetti', 'franchise_en_base', 'exonere']).nullable().optional(), legalForm: z.string().trim().min(1).nullable().optional(), buyerReference: z.string().trim().min(1).nullable().optional() }).strict()
export const updateMerchantAccountContactBodySchema = z.object({ firstName: z.string().trim().min(1), lastName: z.string().trim().min(1), phone: z.string().trim().regex(frenchPhone, 'Invalid French phone number') }).strict()

export const merchantSignupBodySchema = z.object({
  merchantName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(72),
  passwordConfirmation: z.string()
}).strict().superRefine((value, context) => {
  if (value.password !== value.passwordConfirmation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['passwordConfirmation'], message: 'Password confirmation must match password' })
  }
})
