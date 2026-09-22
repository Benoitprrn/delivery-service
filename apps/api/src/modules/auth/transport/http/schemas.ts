import { z } from 'zod'

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
