import type {PoolClient} from 'pg';
import {db,query} from '../db';
import {conversationKey} from '../phone';
import {contentDigest,type ExecutionContext} from './contracts';
export interface Control {state:'bot'|'waiting_human'|'human';ownerId:string|null;controlVersion:number}
const controlFrom=(r:Record<string,unknown>):Control=>({state:r.state as Control['state'],ownerId:r.owner_id as string|null,controlVersion:r.control_version as number});
/** The lock is held through dispatch: takeover cannot race the final authorization. */
async function locked<T>(orgId:string,phone:string,fn:(client:PoolClient,control:Control)=>Promise<T>):Promise<T>{
 const client=await db().connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${orgId}:${conversationKey(phone)}`]);
  await client.query(`INSERT INTO conversation_control(org_id,phone) VALUES($1,$2) ON CONFLICT DO NOTHING`,[orgId,conversationKey(phone)]);
  const {rows}=await client.query('SELECT * FROM conversation_control WHERE org_id=$1 AND phone=$2 FOR UPDATE',[orgId,conversationKey(phone)]);
  const result=await fn(client,controlFrom(rows[0]));await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function getControl(orgId:string,phone:string):Promise<Control>{
 const rows=await query('SELECT * FROM conversation_control WHERE org_id=$1 AND phone=$2',[orgId,conversationKey(phone)]);
 return rows[0]?controlFrom(rows[0]):{state:'bot',ownerId:null,controlVersion:0};
}
export async function transitionControl(p:{orgId:string;phone:string;operation:'request'|'claim'|'handback';actorId:string;controlVersion?:number;beforeTransition?:(client:PoolClient)=>Promise<void>}):Promise<Control>{
 return locked(p.orgId,p.phone,async(client,c)=>{
  if(p.controlVersion!==undefined&&p.controlVersion!==c.controlVersion)throw new Error('control_conflict');
  if(p.operation==='handback'){const unresolved=await client.query(`SELECT 1 FROM handoff_send WHERE org_id=$1 AND phone=$2 AND state IN ('running','unknown') LIMIT 1`,[p.orgId,conversationKey(p.phone)]);if(unresolved.rows.length)throw new Error('send_unknown');}
  if(p.operation==='request'&&c.state==='bot')c={state:'waiting_human',ownerId:null,controlVersion:c.controlVersion+1};
  else if(p.operation==='claim'&&c.state==='waiting_human'&&p.controlVersion!==undefined)c={state:'human',ownerId:p.actorId,controlVersion:c.controlVersion+1};
  else if(p.operation==='handback'&&c.state==='human'&&c.ownerId===p.actorId&&p.controlVersion!==undefined)c={state:'bot',ownerId:null,controlVersion:c.controlVersion+1};
  else throw new Error('control_conflict');
  if(p.beforeTransition)await p.beforeTransition(client);
  await client.query(`UPDATE conversation_control SET state=$3,owner_id=$4,control_version=$5,updated_at=now() WHERE org_id=$1 AND phone=$2`,[p.orgId,conversationKey(p.phone),c.state,c.ownerId,c.controlVersion]);return c;
 });
}
export async function withBotFence<T>(orgId:string,phone:string,version:number,send:()=>Promise<T>):Promise<{sent:false}|{sent:true;result:T}>{
 return locked(orgId,phone,async(_client,c)=>c.state==='bot'&&c.controlVersion===version?{sent:true as const,result:await send()}:{sent:false as const});
}
export async function assertBotWrite(ctx:ExecutionContext,phone:string):Promise<void>{
 if(ctx.mode!=='live')return;
 const control=await getControl(ctx.orgId,phone);
 if(control.state!=='bot'||control.controlVersion!==ctx.controlVersion)throw new Error('control_conflict');
}
/** A separate committed reservation survives transport errors and process death. */
export async function sendHuman(p:{orgId:string;phone:string;actorId:string;controlVersion:number;requestId:string;text:string;beforeReserve?:(client:PoolClient)=>Promise<void>},send:()=>Promise<{messageId:string|null}>):Promise<{messageId:string|null}>{
 const digest=contentDigest({phone:conversationKey(p.phone),actorId:p.actorId,text:p.text,version:p.controlVersion});
 await locked(p.orgId,p.phone,async(client,c)=>{
  if(p.beforeReserve)await p.beforeReserve(client);
  if(c.state!=='human'||c.ownerId!==p.actorId||c.controlVersion!==p.controlVersion)throw new Error('control_conflict');
  const unresolved=await client.query(`SELECT 1 FROM handoff_send WHERE org_id=$1 AND phone=$2 AND state IN ('running','unknown') LIMIT 1`,[p.orgId,conversationKey(p.phone)]);
  if(unresolved.rows.length)throw new Error('send_unknown');
  const reserved=await client.query(`INSERT INTO handoff_send(org_id,request_id,phone,actor_id,content_digest,control_version,state) VALUES($1,$2,$3,$4,$5,$6,'running') ON CONFLICT DO NOTHING RETURNING request_id`,[p.orgId,p.requestId,conversationKey(p.phone),p.actorId,digest,p.controlVersion]);
  if(!reserved.rows.length)throw new Error('send_unknown');
 });
 try{
  const result=await locked(p.orgId,p.phone,async(_client,c)=>{
   if(p.beforeReserve)await p.beforeReserve(_client);
   if(c.state!=='human'||c.ownerId!==p.actorId||c.controlVersion!==p.controlVersion)throw new Error('control_conflict');
   return send();
  });
  if(!result.messageId)throw new Error('send_unknown');
  await query(`UPDATE handoff_send SET state='succeeded',provider_message_id=$3 WHERE org_id=$1 AND request_id=$2`,[p.orgId,p.requestId,result.messageId]);return result;
 }catch(error){
  await query(`UPDATE handoff_send SET state='unknown' WHERE org_id=$1 AND request_id=$2`,[p.orgId,p.requestId]);throw error;
 }
}
