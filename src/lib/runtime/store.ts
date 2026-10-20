import { withPrivacyFence } from "./privacy";
import { randomUUID } from 'node:crypto';
import { query } from '../db';
import { currentExecution, runEvent } from './context';
import { contentDigest, type ExecutionContext, type RunEvent } from './contracts';
export async function startTask(ctx:ExecutionContext):Promise<boolean> {
 const insert=async(client:{query:Function})=>client.query(`INSERT INTO runtime_task(id,org_id,conversation_id,subject_digest,workflow_version,mode,state,lease_until,person_digest,privacy_epoch)
 VALUES($1,$2,$3,$4,$5,$6,'running',to_timestamp($7/1000.0),$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id`,[ctx.taskId,ctx.orgId,ctx.conversationId,contentDigest(ctx.subject),ctx.workflowVersion,ctx.mode,ctx.deadline,ctx.personDigest??null,ctx.privacyEpoch??0]);
 const result=await withPrivacyFence(ctx,insert);
 return result.rows.length>0;
}
export async function finishTask(ctx:ExecutionContext,state:string,events:RunEvent[]):Promise<void> {
 for(const event of events) await query(`INSERT INTO runtime_event(id,task_id,org_id,kind,name,at,data) VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7) ON CONFLICT DO NOTHING`,[event.id,ctx.taskId,ctx.orgId,event.kind,event.name,event.at,JSON.stringify(event.data??{})]);
 await query(`UPDATE runtime_task SET state=CASE WHEN EXISTS(SELECT 1 FROM execution_intent i WHERE i.task_id=runtime_task.id AND i.state='unknown') THEN 'unknown' ELSE $3 END,updated_at=now() WHERE id=$1 AND org_id=$2 AND state='running'`,[ctx.taskId,ctx.orgId,state]);
}
export async function getTaskEvents(orgId:string,taskId:string) { return query(`SELECT id,task_id AS "taskId",org_id AS "orgId",kind,name,extract(epoch FROM at)*1000 AS at,data FROM runtime_event WHERE org_id=$1 AND task_id=$2 ORDER BY at,id`,[orgId,taskId]); }
export async function expireLeases():Promise<void> {
 await query(`WITH expired AS (UPDATE runtime_task SET state='unknown',updated_at=now() WHERE state='running' AND lease_until<now() RETURNING id) UPDATE execution_intent SET state='unknown',updated_at=now() WHERE state='running' AND task_id IN(SELECT id FROM expired)`);
}
interface ActionResult {status:number;body:Record<string,unknown>}
/** Reserve BEFORE any write. An unresolved reservation is never an authorization to retry. */
export async function executeIntent(params:{verb:string;key:string;args:unknown},effect:()=>Promise<ActionResult|null>):Promise<ActionResult|null> {
 const execution=currentExecution(); if(!execution) return effect();
 const ctx=execution.context;
 if(ctx.mode==='simulation') {runEvent('tool.simulated',params.verb);return {status:409,body:{error:'simulation_effect_denied',simulated:true}};}
 const digest=contentDigest(params.args),subjectDigest=contentDigest(ctx.subject);
 const rows=await query(`WITH task AS (SELECT id FROM runtime_task WHERE id=$2 AND org_id=$3 AND state IN ('queued','running','waiting_input','waiting_approval') FOR UPDATE)
 INSERT INTO execution_intent(id,task_id,org_id,idempotency_key,verb,content_digest,subject_digest,state)
 SELECT $1,$2,$3,$4,$5,$6,$7,'running' FROM task ON CONFLICT(org_id,verb,idempotency_key) DO NOTHING RETURNING id`,[randomUUID(),ctx.taskId,ctx.orgId,params.key,params.verb,digest,subjectDigest]);
 if(!rows.length){
  const [prior]=await query(`SELECT state,content_digest,subject_digest FROM execution_intent WHERE org_id=$1 AND verb=$2 AND idempotency_key=$3`,[ctx.orgId,params.verb,params.key]);
  return {status:409,body:{error:prior?.content_digest!==digest||prior?.subject_digest!==subjectDigest?'idempotency_conflict':prior?.state==='succeeded'?'execution_already_completed':'execution_unknown'}};
 }
 runEvent('intent.reserved',params.verb);
 try{
  const result=await effect();
  const state=result===null||result.status>=500?'unknown':result.status>=400?'failed':'succeeded';
  await query(`UPDATE execution_intent SET state=$4,updated_at=now() WHERE org_id=$1 AND verb=$2 AND idempotency_key=$3 AND state='running'`,[ctx.orgId,params.verb,params.key,state]);
  runEvent(`intent.${state}`,params.verb);return result;
 }catch(error){
  await query(`UPDATE execution_intent SET state='unknown',updated_at=now() WHERE org_id=$1 AND verb=$2 AND idempotency_key=$3 AND state='running'`,[ctx.orgId,params.verb,params.key]);
  runEvent('intent.unknown',params.verb);throw error;
 }
}
export async function bindPlaygroundSession(sessionId:string,orgId:string,phone:string,mode:string,context?:ExecutionContext):Promise<boolean> {
 const digest=contentDigest(phone),subjectDigest=context?contentDigest(context.subject):null;
 const bind=async(client:{query:Function})=>{
  await client.query(`INSERT INTO playground_session(id,org_id,phone_digest,mode,subject_digest,conversation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[sessionId,orgId,digest,mode,subjectDigest,context?.conversationId??null]);
  const result=await client.query(`SELECT id FROM playground_session WHERE id=$1 AND org_id=$2 AND phone_digest=$3 AND mode=$4 AND subject_digest IS NOT DISTINCT FROM $5`,[sessionId,orgId,digest,mode,subjectDigest]);return result.rows.length===1;
 };
 return context?withPrivacyFence(context,bind):bind({query:async(sql:string,args:unknown[])=>({rows:await query(sql,args)})});
}
