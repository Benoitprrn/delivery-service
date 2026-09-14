import { z } from 'zod'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID')
const expectedVersion = z.number().int().min(1)
const pickupScheduledAtSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('asap') }).strict(),
  z.object({ mode: z.literal('delay'), delayMinutes: z.number().int().positive().max(120) }).strict(),
  z.object({ mode: z.literal('scheduled'), at: z.string().datetime({ offset: true }).transform((value) => new Date(value)) }).strict()
])

export const createOrderBodySchema = z
  .object({
    merchantId: uuid,
    customerName: z.string().trim().min(1),
    customerPhone: z.string().trim().min(1),
    customerEmail: z.string().trim().email().optional(),
    pickupScheduledAt: pickupScheduledAtSchema,
    orderDetails: z.string().trim().min(1).optional(),
    deliveryInstructions: z.string().trim().min(1).optional(),
    deliveryAddressComplement: z.string().trim().min(1).optional(),
    deliveryAddress: z.string().trim().min(1),
    deliveryLat: z.number().min(-90).max(90),
    deliveryLng: z.number().min(-180).max(180)
  })
  .strict()

export const listAvailableOrdersQuerySchema = z.object({ zoneId: uuid }).strict()

export const estimateOrderQuerySchema = z.object({ deliveryAddress: z.string().trim().min(1) }).strict()

export const emptyQuerySchema = z.object({}).strict()

export const orderIdParamsSchema = z.object({ id: uuid }).strict()

export const orderTransitionBodySchema = z
  .object({
    expectedVersion
  })
  .strict()

export const completeOrderBodySchema = z
  .object({
    expectedVersion,
    proof: z.discriminatedUnion('method', [
      z.object({ method: z.literal('code'), code: z.string().regex(/^\d{4}$/, 'Code must contain four digits') }).strict(),
      z.object({ method: z.literal('signature'), imageBase64: z.string().min(4).max(400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
      z.object({ method: z.literal('photo'), imageBase64: z.string().min(4).max(700_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()
    ])
  })
  .strict()
