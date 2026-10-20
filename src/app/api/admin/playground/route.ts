import { privacyEpoch } from "@/lib/runtime/privacy";
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {requireHmac} from '@/lib/auth';
import {invokeIsolatedGraph} from '@/graph/graph';
import {resolveIdentity,type Candidate} from '@/lib/identity';
import {limparThreadDoCheckpointer} from '@/lib/checkpointer-reset';
import {conversationKey} from '@/lib/phone';
import {redigirCredito} from '@/lib/pii';
import {withExecution,currentExecution,namespaceFor,runEvent} from '@/lib/runtime/context';
import {CATALOG_VERSION,WORKFLOW_VERSION,contentDigest,type ExecutionContext} from '@/lib/runtime/contracts';
import {bindPlaygroundSession,startTask,finishTask} from '@/lib/runtime/store';
import {PlaygroundRequestSchema,stagingIdentityAllowed,savePlaygroundMessage,playgroundHistory} from '@/lib/runtime/playground';
export const dynamic='force-dynamic';export const runtime='nodejs';export const maxDuration=120;
/** Same graph and policy/confirmation logic. Only the service adapters and namespace differ. */
export async function POST(req:NextRequest){
 if(process.env.MAX_PLAYGROUND!=='true')return new NextResponse(null,{status:404});
 const auth=await requireHmac(req);if(!auth.ok)return auth.response;
 let value:unknown;try{value=JSON.parse(auth.rawBody);}catch{return NextResponse.json({error:'invalid_json'},{status:400});}
 const parsed=PlaygroundRequestSchema.safeParse(value);if(!parsed.success)return NextResponse.json({error:'bad_request',issues:parsed.error.issues},{status:400});
 const p=parsed.data;
 const personDigest=contentDigest(conversationKey(p.phone));
 const epoch=await privacyEpoch(personDigest);
 let identity:Candidate={kind:'user',userId:`fixture-${p.sessionId}`,userName:'Pessoa sintética',orgId:p.orgId,orgName:'Imobiliária de simulação'};
 if(p.mode==='staging'){
  if(!stagingIdentityAllowed(p.orgId,p.phone))return NextResponse.json({error:'synthetic_identity_required'},{status:403});
  const resolved=await resolveIdentity(p.phone);
  if(resolved.kind!=='resolved'||resolved.candidate.orgId!==p.orgId)return NextResponse.json({error:'identidade_diverge'},{status:409});
  identity=resolved.candidate;
 }
 const subject=identity.kind==='user'?{kind:'user' as const,userId:identity.userId}:{kind:'broker' as const,splitRecipientId:identity.splitRecipientId};
 const threadId=namespaceFor(p.mode,p.orgId,p.phone,p.sessionId,contentDigest(subject));
 const context:ExecutionContext={personDigest,privacyEpoch:epoch,orgId:p.orgId,subject:identity.kind==='user'?{kind:'user',userId:identity.userId}:{kind:'broker',splitRecipientId:identity.splitRecipientId},conversationId:threadId,taskId:p.requestId,mode:p.mode,workflowVersion:WORKFLOW_VERSION,controlVersion:0,deadline:Date.now()+110000,budgetUsd:p.mode==='simulation'?0:0.25,maxConcurrency:3};
 if(!await bindPlaygroundSession(p.sessionId,p.orgId,conversationKey(p.phone),p.mode,context))return NextResponse.json({error:'session_conflict'},{status:409});
 if(!await startTask(context))return NextResponse.json({error:'repetido'},{status:409});
 try{
  if(p.novo)await limparThreadDoCheckpointer(threadId);
  if(!p.text){await finishTask(context,'succeeded',[]);return NextResponse.json({reply:null,rastro:null,threadId,sessionId:p.sessionId,mode:p.mode,traces:[],catalogVersion:CATALOG_VERSION,workflowVersion:WORKFLOW_VERSION});}
  const {result,events}=await withExecution(context,async()=>{
   runEvent('run.started','max');
   const result=await invokeIsolatedGraph({messageId:`playground-${p.requestId}`,fromPhone:p.phone,kind:'text',text:p.text!,groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()},identity,threadId);
   runEvent('run.completed','max');return {result,events:currentExecution()!.events};
  });
  // No afterReply: production memory/identity/transport are outside this namespace.
  await savePlaygroundMessage(p.sessionId,p.requestId,'user',p.text);
  if(result.reply)await savePlaygroundMessage(p.sessionId,p.requestId,'assistant',result.reply);
  await finishTask(context,'succeeded',events);
  const rastro={orgId:p.orgId,route:'graph',inboundText:redigirCredito(p.text),replyText:result.reply?redigirCredito(result.reply):null,tools:(result.toolLog??[]).map(t=>({name:t.name,outcome:t.outcome})),usage:result.usage??[],timings:result.timings??[],identidade:{kind:p.mode==='simulation'?'fixture':'resolved',orgId:p.orgId}};
  return NextResponse.json({reply:result.reply??null,rastro,threadId,sessionId:p.sessionId,mode:p.mode,traces:events,catalogVersion:CATALOG_VERSION,workflowVersion:WORKFLOW_VERSION});
 }catch(error){await finishTask(context,'unknown',[]);console.error('[playground] execution failed',error instanceof Error?error.name:'unknown');return NextResponse.json({error:'execution_unknown',sessionId:p.sessionId,mode:p.mode},{status:409});}
}
const historySchema=z.object({orgId:z.string().min(1),phone:z.string().regex(/^\+[1-9]\d{6,14}$/),sessionId:z.string().uuid(),mode:z.enum(['simulation','staging'])});
export async function GET(req:NextRequest){
 if(process.env.MAX_PLAYGROUND!=='true')return new NextResponse(null,{status:404});
 const auth=await requireHmac(req,{signQuery:true});if(!auth.ok)return auth.response;
 const parsed=historySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));if(!parsed.success)return NextResponse.json({error:'bad_request'},{status:400});
 if(parsed.data.mode==='staging'&&!stagingIdentityAllowed(parsed.data.orgId,parsed.data.phone))return NextResponse.json({error:'synthetic_identity_required'},{status:403});
 let subjectDigest=contentDigest({kind:'user',userId:`fixture-${parsed.data.sessionId}`});
 if(parsed.data.mode==='staging'){
  const identity=await resolveIdentity(parsed.data.phone);
  if(identity.kind!=='resolved'||identity.candidate.orgId!==parsed.data.orgId)return NextResponse.json({error:'identidade_diverge'},{status:409});
  subjectDigest=contentDigest(identity.candidate.kind==='user'?{kind:'user',userId:identity.candidate.userId}:{kind:'broker',splitRecipientId:identity.candidate.splitRecipientId});
 }
 const history=await playgroundHistory({...parsed.data,subjectDigest});return history?NextResponse.json(history):NextResponse.json({error:'session_not_found'},{status:404});
}
