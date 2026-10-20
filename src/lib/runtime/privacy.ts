import type {PoolClient} from 'pg';
import {db} from '../db';
import {currentExecution} from './context';
import type {ExecutionContext} from './contracts';
export async function privacyEpoch(personDigest:string):Promise<number>{
 const result=await db().query('SELECT epoch FROM runtime_privacy_epoch WHERE person_digest=$1',[personDigest]);return Number(result.rows[0]?.epoch??0);
}
/** Shares an advisory lock with erasure. Held through each write/checkpoint/effect. */
export async function withPrivacyFence<T>(context:ExecutionContext,fn:(client:PoolClient)=>Promise<T>,controlFence=false):Promise<T>{
 const client=await db().connect();
 try{
  await client.query('BEGIN');
  if(context.personDigest){
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy:${context.personDigest}`]);
   const {rows}=await client.query('SELECT epoch FROM runtime_privacy_epoch WHERE person_digest=$1',[context.personDigest]);
   if(Number(rows[0]?.epoch??0)!==(context.privacyEpoch??0))throw new Error('execution_revoked');
  }
  if(controlFence&&context.mode==='live'){
   const key=context.controlKey??context.conversationId;
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
   const phone=key.slice(key.lastIndexOf(':')+1);
   const {rows}=await client.query('SELECT state,control_version FROM conversation_control WHERE org_id=$1 AND phone=$2',[context.orgId,phone]);
   if((rows[0]?.state??'bot')!=='bot'||Number(rows[0]?.control_version??0)!==context.controlVersion)throw new Error('control_conflict');
  }
  const result=await fn(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function protectCheckpoint<T>(fn:()=>Promise<T>):Promise<T>{
 const ctx=currentExecution()?.context;return ctx?.personDigest?withPrivacyFence(ctx,()=>fn(),true):fn();
}
