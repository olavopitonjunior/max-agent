import {z} from 'zod';
import type {PoolClient} from 'pg';
import {db} from '../db';
import {conversationKey} from '../phone';
import {currentExecution} from './context';
import {contentDigest} from './contracts';
import {privacyEpoch} from './privacy';
export const DispatchFenceSchema=z.object({personDigest:z.string().regex(/^[a-f0-9]{64}$/),privacyEpoch:z.number().int().nonnegative(),orgId:z.string().optional(),subjectDigest:z.string().optional(),controlVersion:z.number().int().nonnegative().optional(),conversationId:z.string().optional()}).strict();
export type DispatchFence=z.infer<typeof DispatchFenceSchema>;
export async function captureDispatchFence(phone:string):Promise<DispatchFence>{
 const personDigest=contentDigest(conversationKey(phone)),ctx=currentExecution()?.context;
 return {personDigest,privacyEpoch:ctx?.personDigest===personDigest?ctx.privacyEpoch??0:await privacyEpoch(personDigest)};
}
/** Common order is privacy → control → queue/checkpoint. */
export async function withCapturedPrivacy<T>(fence:DispatchFence,fn:(client:PoolClient)=>Promise<T>):Promise<T>{
 const f=DispatchFenceSchema.parse(fence),client=await db().connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy:${f.personDigest}`]);
  const epoch=await client.query('SELECT epoch FROM runtime_privacy_epoch WHERE person_digest=$1',[f.personDigest]);
  if(Number(epoch.rows[0]?.epoch??0)!==f.privacyEpoch)throw new Error('execution_revoked');
  const result=await fn(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function withDeliveryFence<T>(p:{table:'inbound_queue'|'outbox';id:string;phone:string;fence:DispatchFence},fn:(client:PoolClient)=>Promise<T>):Promise<T>{
 const f=DispatchFenceSchema.parse(p.fence),phone=conversationKey(p.phone);
 if(f.personDigest!==contentDigest(phone))throw new Error('execution_revoked');
 return withCapturedPrivacy(f,async(client)=>{
  if(f.orgId&&f.controlVersion!==undefined){
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${f.orgId}:${phone}`]);
   const control=await client.query('SELECT state,control_version FROM conversation_control WHERE org_id=$1 AND phone=$2',[f.orgId,phone]);
   if((control.rows[0]?.state??'bot')!=='bot'||Number(control.rows[0]?.control_version??0)!==f.controlVersion)throw new Error('control_conflict');
  }
  if(f.orgId&&f.subjectDigest){
   const binding=await client.query('SELECT subject_digest FROM live_conversation_binding WHERE org_id=$1 AND phone=$2 ORDER BY bound_at DESC LIMIT 1',[f.orgId,phone]);
   if(binding.rows[0]&&binding.rows[0].subject_digest!==f.subjectDigest)throw new Error('control_conflict');
  }
  const column=p.table==='inbound_queue'?'from_phone':'phone';
  const row=await client.query(`SELECT id FROM ${p.table} WHERE id=$1 AND ${column}=$2 FOR UPDATE`,[p.id,phone]);
  if(!row.rows.length)throw new Error('execution_revoked');
  return fn(client);
 });
}
