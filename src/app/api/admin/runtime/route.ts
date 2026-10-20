import { z } from "zod";
import {NextRequest,NextResponse} from 'next/server';
import {requireHmac} from '@/lib/auth';
import {query,db} from '@/lib/db';
import {CATALOG_VERSION,WORKFLOW_VERSION} from '@/lib/runtime/contracts';
export const dynamic='force-dynamic';export const runtime='nodejs';
/** Safe operational metadata only; no subjects, phones, args or private prompts. */
export async function GET(req:NextRequest){
 const auth=await requireHmac(req,{signQuery:true});if(!auth.ok)return auth.response;
 const orgId=req.nextUrl.searchParams.get('orgId');if(!orgId)return NextResponse.json({error:'bad_request'},{status:400});
 const [counts,tasks,unknownIntents,inbound,handoffs]=await Promise.all([
  query(`SELECT count(*)::int AS tasks,count(*) FILTER(WHERE state='unknown')::int AS unknown,count(*) FILTER(WHERE state='running' AND lease_until<now())::int AS overdue,count(*) FILTER(WHERE created_at>now()-interval '15 minutes')::int AS total15m,count(*) FILTER(WHERE state IN ('failed','unknown') AND created_at>now()-interval '15 minutes')::int AS failed15m FROM runtime_task WHERE org_id=$1`,[orgId]),
  query(`SELECT t.id,t.state,t.workflow_version AS "workflowVersion",t.mode,t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.lease_until AS "deadlineAt",COALESCE((SELECT sum((e.data->>'costUsd')::numeric) FROM runtime_event e WHERE e.task_id=t.id AND e.kind='model.completed' AND jsonb_typeof(e.data->'costUsd')='number'),0)::float AS "spentUsd" FROM runtime_task t WHERE t.org_id=$1 ORDER BY t.created_at DESC LIMIT 101`,[orgId]),
  query(`SELECT id,task_id AS "taskId",verb,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM execution_intent WHERE org_id=$1 AND state IN ('unknown','running') ORDER BY created_at LIMIT 101`,[orgId]),
  query(`SELECT GREATEST(0,extract(epoch FROM (now()-min(created_at)))*1000)::float AS age FROM inbound_queue WHERE status IN ('pending','processing')`),
  query(`SELECT count(*)::int AS n,count(*) FILTER(WHERE state='waiting_human' AND owner_id IS NULL)::int AS no_owner FROM conversation_control WHERE org_id=$1 AND state IN ('waiting_human','human')`,[orgId]),
 ]);
 const c=counts[0]??{},total15m=Number(c.total15m??0),failed15m=Number(c.failed15m??0),failureRate=total15m?failed15m/total15m:0;
 return NextResponse.json({workflowVersion:WORKFLOW_VERSION,catalogVersion:CATALOG_VERSION,killSwitches:{chat:process.env.MAX_CHAT_KILL==='true',writes:process.env.MAX_WRITES_KILL==='true',paid:process.env.MAX_PAID_KILL==='true',outbound:process.env.MAX_OUTBOUND_KILL==='true'},summary:{tasks:Number(c.tasks??0),unknown:Number(c.unknown??0),activeHandoffs:Number(handoffs[0]?.n??0),oldestInboundAgeMs:inbound[0]?.age??null,inboundScope:'instance',total15m,failed15m,failureRate,alertFailureRate:total15m>=20&&failureRate>0.05,overdueTasks:Number(c.overdue??0),handoffNoOwner:Number(handoffs[0]?.no_owner??0),alertHandoffNoOwner:Number(handoffs[0]?.no_owner??0)>0,alertUnknown:Number(c.unknown??0)>0,alertOldestInbound:Number(inbound[0]?.age??0)>120000,alertDeadline:Number(c.overdue??0)>0,budget80:tasks.filter(t=>Number(t.spentUsd)>=0.2).length,budget100:tasks.filter(t=>Number(t.spentUsd)>=0.25).length},tasks:tasks.slice(0,100),unknownIntents:unknownIntents.slice(0,100),truncated:tasks.length>100||unknownIntents.length>100,budget:{limitUsdPerRun:0.25,enforcement:'shared measured cost; subsequent model calls blocked at limit',quotaOwner:'ImobPro'}});
}

const cancelSchema=z.object({orgId:z.string().min(1),taskId:z.string().uuid(),operation:z.literal('cancel'),expectedState:z.literal('queued'),actorId:z.string().min(1)}).strict();
export async function POST(req:NextRequest){
 const auth=await requireHmac(req);if(!auth.ok)return auth.response;
 let value:unknown;try{value=JSON.parse(auth.rawBody);}catch{return NextResponse.json({error:'invalid_json'},{status:400});}
 const parsed=cancelSchema.safeParse(value);if(!parsed.success)return NextResponse.json({error:'bad_request'},{status:400});
 const p=parsed.data;
 const client=await db().connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT id FROM runtime_task WHERE id=$1 AND org_id=$2 FOR UPDATE',[p.taskId,p.orgId]);
  // Separate statement obtains a fresh READ COMMITTED snapshot after the lock.
  const result=await client.query(`UPDATE runtime_task t SET state='cancelled',updated_at=now() WHERE t.id=$1 AND t.org_id=$2 AND t.state='queued' AND NOT EXISTS(SELECT 1 FROM execution_intent i WHERE i.task_id=t.id AND i.state IN ('running','succeeded','unknown')) RETURNING t.id`,[p.taskId,p.orgId]);
  await client.query('COMMIT');
  return result.rows.length?NextResponse.json({ok:true,taskId:p.taskId,state:'cancelled'}):NextResponse.json({error:'task_conflict'},{status:409});
 } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
