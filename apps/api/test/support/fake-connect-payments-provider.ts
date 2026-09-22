import { ConnectResourceMissingError, PaymentIntentUnexpectedStateError, type ConnectAccountStatus, type ConnectPaymentsProvider, type TerminalPaymentIntent } from '../../src/modules/cash-on-delivery/ports/connect-payments-provider.js'

type Stored = TerminalPaymentIntent & { captureKeys: Set<string> }
export class FakeConnectPaymentsProvider implements ConnectPaymentsProvider {
  readonly calls={getAccountStatus:0,ensureTerminalLocation:0,createConnectionToken:0,createTerminalPaymentIntent:0,retrievePaymentIntent:0,capturePaymentIntent:0,cancelPaymentIntent:0}
  accountStatus:ConnectAccountStatus={accountId:'acct_test',merchantConfigured:true,dashboard:'full',cardPayments:'active',cartesBancaires:'active',requirementsCount:0}
  private sequence=0
  readonly captureKeysUsed:string[]=[]
  readonly cancelKeysUsed:string[]=[]
  retrieveDelayMs=0
  readonly intents=new Map<string,Stored>(); nextStatus:'requires_payment_method'|'requires_capture'='requires_payment_method'; contamination:Partial<TerminalPaymentIntent>|null=null; unexpectedCapture=false; failNext=false
  async addMerchantConfiguration():Promise<void>{}
  async createOnboardingLink():Promise<{url:string;expiresAt:Date}>{return {url:'https://test',expiresAt:new Date()}}
  async getAccountStatus(accountId:string):Promise<ConnectAccountStatus>{this.calls.getAccountStatus++;return {...this.accountStatus,accountId}}
  async ensureTerminalLocation(input:{accountId:string}):Promise<{locationId:string}>{this.calls.ensureTerminalLocation++;return {locationId:`tml_${input.accountId}`}}
  async createConnectionToken(input:{accountId:string;locationId:string}):Promise<{secret:string}>{this.calls.createConnectionToken++;return {secret:`pst_${input.accountId}_${input.locationId}`}}
  async createTerminalPaymentIntent(input:{accountId:string;amountCents:number;currency:'eur';idempotencyKey:string;metadata:{orderId:string;merchantId:string;paymentId:string}}):Promise<TerminalPaymentIntent>{
    this.calls.createTerminalPaymentIntent++; if(this.failNext){this.failNext=false;throw new Error('network')}; const old=[...this.intents.values()].find(x=>(x as Stored & {createKey?:string}).createKey===input.idempotencyKey);if(old)return this.copy(old)
    const id=`pi_${++this.sequence}`;const p:Stored={id,accountId:input.accountId,status:this.nextStatus,amountCents:input.amountCents,amountCapturableCents:0,amountReceivedCents:0,currency:input.currency,clientSecret:`${id}_secret`,metadata:{order_id:input.metadata.orderId,merchant_id:input.metadata.merchantId,payment_id:input.metadata.paymentId},captureMethod:'manual',paymentMethodTypes:['card_present'],applicationFeeAmountCents:null,hasTransferData:false,hasOnBehalfOf:false,chargeId:null,lastPaymentErrorCode:null,lastPaymentErrorDeclineCode:null,captureKeys:new Set(),createKey:input.idempotencyKey} as Stored & {createKey:string};Object.assign(p,this.contamination??{});this.intents.set(id,p);return this.copy(p)
  }
  async retrievePaymentIntent(input:{accountId:string;paymentIntentId:string}):Promise<TerminalPaymentIntent>{this.calls.retrievePaymentIntent++;const p=this.intents.get(input.paymentIntentId);if(!p||p.accountId!==input.accountId)throw new ConnectResourceMissingError();const answer=this.copy(p);if(this.retrieveDelayMs>0)await new Promise((resolve)=>setTimeout(resolve,this.retrieveDelayMs));return answer}
  async capturePaymentIntent(input:{accountId:string;paymentIntentId:string;idempotencyKey:string}):Promise<TerminalPaymentIntent>{this.calls.capturePaymentIntent++;this.captureKeysUsed.push(input.idempotencyKey);const p=this.intents.get(input.paymentIntentId);if(!p||p.accountId!==input.accountId)throw new ConnectResourceMissingError();if(p.status==='succeeded'){if(p.captureKeys.has(input.idempotencyKey))return this.copy(p);throw new PaymentIntentUnexpectedStateError()}if(this.unexpectedCapture){this.unexpectedCapture=false;p.status='succeeded';p.amountReceivedCents=p.amountCents;p.chargeId=`ch_${p.id}`;throw new PaymentIntentUnexpectedStateError()}if(p.status!=='requires_capture')throw new PaymentIntentUnexpectedStateError();p.status='succeeded';p.amountReceivedCents=p.amountCents;p.chargeId=`ch_${p.id}`;p.captureKeys.add(input.idempotencyKey);return this.copy(p)}
  async cancelPaymentIntent(input:{accountId:string;paymentIntentId:string;idempotencyKey?:string}):Promise<TerminalPaymentIntent>{this.calls.cancelPaymentIntent++;if(input.idempotencyKey!==undefined)this.cancelKeysUsed.push(input.idempotencyKey);const p=this.intents.get(input.paymentIntentId);if(!p||p.accountId!==input.accountId)throw new ConnectResourceMissingError();if(p.status==='succeeded')throw new PaymentIntentUnexpectedStateError();p.status='canceled';return this.copy(p)}
  decline(id:string,code='generic_decline'){const p=this.intents.get(id)!;p.status='requires_payment_method';p.lastPaymentErrorCode='card_declined';p.lastPaymentErrorDeclineCode=code}
  authorize(id:string){const p=this.intents.get(id)!;p.status='requires_capture';p.amountCapturableCents=p.amountCents}
  private copy(p:Stored):TerminalPaymentIntent{const rest:Partial<Stored>={...p};delete rest.captureKeys;const v=rest as TerminalPaymentIntent;return {...v,metadata:{...v.metadata},paymentMethodTypes:[...v.paymentMethodTypes]}}
}
