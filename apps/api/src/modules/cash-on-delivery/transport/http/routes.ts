import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { CompletionHttpError, type DeliveryCompletionUseCases } from '../../application/delivery-completion.js'
import { ConnectProviderError, ConnectUnavailableError } from '../../ports/connect-payments-provider.js'

const uuid=z.string().uuid()
const orderParams=z.object({id:uuid}).strict()
const sessionParams=z.object({id:uuid,sessionId:uuid}).strict()
const createBody=z.object({expectedVersion:z.number().int().min(1),deliveryCode:z.string().regex(/^\d{4}$/),readerFamily:z.enum(['simulated_bluetooth','bluetooth'])}).strict()
const finalizeBody=z.object({paymentId:uuid}).strict()

function error(request:FastifyRequest,reply:FastifyReply,e:unknown):FastifyReply {
  if(e instanceof z.ZodError)return reply.code(400).send({error:'ValidationError',correlationId:request.correlationId})
  const mapped=e instanceof CompletionHttpError?[e.statusCode,e.code,e.extra] as const:e instanceof ConnectUnavailableError?[503,'StripeUnavailable',{}] as const:e instanceof ConnectProviderError?[502,'StripeProviderError',{}] as const:null
  if(mapped!==null)return reply.code(mapped[0]).send({error:mapped[1],correlationId:request.correlationId,...mapped[2]})
  request.log.error({err:e,correlationId:request.correlationId},'COD completion request failed')
  return reply.code(500).send({error:'InternalServerError',correlationId:request.correlationId})
}
function driver(request:FastifyRequest,reply:FastifyReply):string|null { if(request.authUser?.role==='driver')return request.authUser.id; void reply.code(403).send({error:'ForbiddenError',correlationId:request.correlationId});return null }
export async function registerCashOnDeliveryHttpRoutes(app:FastifyInstance,options:{completion:DeliveryCompletionUseCases}):Promise<void>{
  app.post('/api/v1/orders/:id/delivery-completion-sessions',async(request,reply)=>{try{const driverId=driver(request,reply);if(driverId===null)return reply;const p=orderParams.parse(request.params),b=createBody.parse(request.body);const result=await options.completion.create({orderId:p.id,driverId,expectedVersion:b.expectedVersion,deliveryCode:b.deliveryCode,readerFamily:b.readerFamily,correlationId:request.correlationId});return reply.code((result as {status:string}).status==='completed'?200:201).send(result)}catch(e){return error(request,reply,e)}})
  app.post('/api/v1/orders/:id/terminal/connection-token',{config:{rateLimit:{max:30,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>request.authUser?.id??request.ip}}},async(request,reply)=>{try{const driverId=driver(request,reply);if(driverId===null)return reply;const p=orderParams.parse(request.params);const connectionToken=await options.completion.connectionToken({orderId:p.id,driverId});request.log.info({orderId:p.id,driverId},'Stripe Terminal connection token created');return reply.send(connectionToken)}catch(e){return error(request,reply,e)}})
  app.post('/api/v1/orders/:id/delivery-completion-sessions/:sessionId/finalize',async(request,reply)=>{try{const driverId=driver(request,reply);if(driverId===null)return reply;const p=sessionParams.parse(request.params),b=finalizeBody.parse(request.body);return reply.send(await options.completion.finalize({orderId:p.id,driverId,sessionId:p.sessionId,paymentId:b.paymentId,correlationId:request.correlationId}))}catch(e){return error(request,reply,e)}})
  app.post('/api/v1/orders/:id/delivery-completion-sessions/:sessionId/retry-payment',async(request,reply)=>{try{const driverId=driver(request,reply);if(driverId===null)return reply;const p=sessionParams.parse(request.params);return reply.send(await options.completion.retry({orderId:p.id,driverId,sessionId:p.sessionId,correlationId:request.correlationId}))}catch(e){return error(request,reply,e)}})
  app.get('/api/v1/orders/:id/delivery-completion',async(request,reply)=>{try{const driverId=driver(request,reply);if(driverId===null)return reply;const p=orderParams.parse(request.params);return reply.send(await options.completion.get({orderId:p.id,driverId}))}catch(e){return error(request,reply,e)}})
}
