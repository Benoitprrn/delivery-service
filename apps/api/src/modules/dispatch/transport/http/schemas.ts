import { z } from 'zod'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID')

export const dispatchOfferParamsSchema = z.object({ offerId: uuid }).strict()
export const acceptDispatchOfferBodySchema = z.object({ expectedVersion: z.number().int().min(1) }).strict()
export const rejectDispatchOfferBodySchema = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().trim().min(1).max(500).optional() }).strict()
