import { liveNamespaceFor } from "@/lib/runtime/context";
import type { PoolClient } from "pg";
import { getApp } from "@/graph/graph";
import { withExecution } from "@/lib/runtime/context";
import { contentDigest, WORKFLOW_VERSION, type ExecutionContext } from "@/lib/runtime/contracts";
import { privacyEpoch } from "@/lib/runtime/privacy";
import { registrarTurn } from "@/lib/turnlog";
import { redigirCredito } from "@/lib/pii";
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {requireHmac} from '@/lib/auth';
import {getControl,sendHuman,transitionControl} from '@/lib/runtime/handoff';
import {sendText,connectionStatus} from '@/lib/transport';
import {janelaAberta} from '@/lib/janela24h';
import {resolveIdentity} from '@/lib/identity';
import {query} from '@/lib/db';
import {resolverTelefone} from '@/lib/threads';
import {conversationKey,phoneTag,maskPhone,normalizeBrPhone} from '@/lib/phone';
export const dynamic='force-dynamic';export const runtime='nodejs';
const schema=z.object({orgId:z.string().min(1),phone:z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),threadKey:z.string().regex(/^tel_[0-9a-f]{12}$/).optional(),operation:z.enum(['request','claim','send','handback']),actorId:z.string().min(1),controlVersion:z.number().int().nonnegative().optional(),requestId:z.string().uuid(),text:z.string().min(1).max(4000).optional()}).strict();
export async function POST(req:NextRequest){
 if(process.env.MAX_HANDOFF!=='true')return new NextResponse(null,{status:404});
 const auth=await requireHmac(req);if(!auth.ok)return auth.response;
 let value:unknown;try{value=JSON.parse(auth.rawBody);}catch{return NextResponse.json({error:'invalid_json'},{status:400});}
 const parsed=schema.safeParse(value);if(!parsed.success)return NextResponse.json({error:'bad_request'},{status:400});
 const data=parsed.data;
 const resolvedPhone=data.threadKey ? await resolverTelefone(data.orgId,data.threadKey) : data.phone;
 const phone=resolvedPhone ? normalizeBrPhone(resolvedPhone) : null;
 if(!phone)return NextResponse.json({error:'thread_not_found'},{status:404});
 const identity=await resolveIdentity(phone);
 if(identity.kind!=='resolved'||identity.candidate.orgId!==data.orgId)return NextResponse.json({error:'thread_not_found'},{status:404});
 const thread=await query('SELECT 1 FROM conversation_turn WHERE org_id=$1 AND phone=$2 UNION SELECT 1 FROM outbox WHERE org_id=$1 AND phone=$2 LIMIT 1',[data.orgId,conversationKey(phone)]);
 if(!thread.length)return NextResponse.json({error:'thread_not_found'},{status:404});
 const p={...data,phone};
 const personDigest=contentDigest(conversationKey(phone));
 const context:ExecutionContext={orgId:p.orgId,subject:identity.candidate.kind==='user'?{kind:'user',userId:identity.candidate.userId}:{kind:'broker',splitRecipientId:identity.candidate.splitRecipientId},conversationId:liveNamespaceFor(p.orgId,phone,identity.candidate.kind==='user'?{kind:'user',userId:identity.candidate.userId}:{kind:'broker',splitRecipientId:identity.candidate.splitRecipientId}),controlKey:`${p.orgId}:${conversationKey(phone)}`,taskId:p.requestId,mode:'live',workflowVersion:WORKFLOW_VERSION,controlVersion:p.controlVersion??0,deadline:Date.now()+60000,budgetUsd:1,maxConcurrency:3,personDigest,privacyEpoch:await privacyEpoch(personDigest)};
 const privacyCheck=async(client:PoolClient)=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy:${personDigest}`]);
   const privacy=await client.query('SELECT epoch FROM runtime_privacy_epoch WHERE person_digest=$1',[personDigest]);
   if(Number(privacy.rows[0]?.epoch??0)!==context.privacyEpoch)throw new Error('execution_revoked');
 };
 try{
  if(p.operation==='send'){
   if(!p.text||p.controlVersion===undefined)return NextResponse.json({error:'bad_request'},{status:400});
   if(!await janelaAberta(p.phone))return NextResponse.json({error:'window_closed'},{status:409});
   if(!((await connectionStatus()).connected))return NextResponse.json({error:'channel_unavailable'},{status:409});
   const result=await sendHuman({...p,text:p.text,controlVersion:p.controlVersion,beforeReserve:privacyCheck},()=>sendText({to:p.phone,body:p.text!}));
   await withExecution(context,()=>registrarTurn({orgId:p.orgId,phone:p.phone,messageId:`human-${p.requestId}`,kind:'human',inboundText:null,replyText:redigirCredito(p.text!),route:'human',tools:[{name:'human.send',args:{},outcome:'sent'}]}));
   return NextResponse.json({control:await getControl(p.orgId,p.phone),messageId:result.messageId,status:result.messageId?'sent':'unknown'});
  }
  return NextResponse.json({control:await transitionControl({...p,operation:p.operation,beforeTransition:async(client)=>{
    await privacyCheck(client);
    if(p.operation==='handback'){
      const bindings=await client.query('SELECT thread_id FROM live_conversation_binding WHERE org_id=$1 AND phone=$2',[p.orgId,conversationKey(phone)]);
      const threads=new Set([context.conversationId,`${p.orgId}:${conversationKey(phone)}`,...bindings.rows.map(r=>r.thread_id)]);
      const app=await getApp();for(const thread_id of threads)await app.updateState({configurable:{thread_id}},{pendingAction:null,marketingPending:null,fluxo:null,restoDaResposta:null});
    }
  }})});
 }catch(error){return NextResponse.json({error:error instanceof Error&&['control_conflict','send_unknown'].includes(error.message)?error.message:'send_unknown'},{status:409});}
}

export async function GET(req:NextRequest){
 if(process.env.MAX_HANDOFF!=='true')return new NextResponse(null,{status:404});
 const auth=await requireHmac(req,{signQuery:true});if(!auth.ok)return auth.response;
 const orgId=req.nextUrl.searchParams.get('orgId');if(!orgId)return NextResponse.json({error:'bad_request'},{status:400});
 const threadKey=req.nextUrl.searchParams.get('threadKey');
 const selectedPhone=threadKey?await resolverTelefone(orgId,threadKey):req.nextUrl.searchParams.get('phone');
 if(threadKey&&!selectedPhone)return NextResponse.json({error:'thread_not_found'},{status:404});
 const rows=await query(`SELECT phone,state,owner_id AS "ownerId",control_version AS "controlVersion",reason,created_at AS "createdAt",updated_at AS "updatedAt",EXISTS(SELECT 1 FROM handoff_send s WHERE s.org_id=conversation_control.org_id AND s.phone=conversation_control.phone AND s.state IN ('running','unknown')) AS "outboundUnknown" FROM conversation_control WHERE org_id=$1 AND ($2::text IS NULL OR phone=$2) ORDER BY CASE WHEN state='bot' THEN 1 ELSE 0 END,updated_at DESC LIMIT 101`,[orgId,selectedPhone?conversationKey(selectedPhone):null]);
 return NextResponse.json({truncated:rows.length>100,cases:rows.slice(0,100).map(r=>({...r,key:phoneTag(String(r.phone)),phone:maskPhone(String(r.phone))}))});
}
