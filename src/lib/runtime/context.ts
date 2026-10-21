import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { conversationKey } from '../phone';
import { ExecutionContextSchema, contentDigest, type ExecutionContext, type RunEvent } from './contracts';
export interface Execution { context:ExecutionContext; events:RunEvent[]; spentUsd:number; active:number }
const storage = new AsyncLocalStorage<Execution>();
/** Person-only scope exists before identity/org resolution and survives early returns. */
export interface PersonPrivacy {personDigest:string;privacyEpoch:number}
const privacyStorage=new AsyncLocalStorage<PersonPrivacy>();
export function currentPersonPrivacy():PersonPrivacy|undefined{return privacyStorage.getStore();}
export function withPersonPrivacy<T>(person:PersonPrivacy,fn:()=>T):T{return privacyStorage.run(person,fn);}
export function withExistingExecution<T>(execution:Execution,fn:()=>T):T{return storage.run(execution,fn);}
export function currentExecution():Execution|undefined { return storage.getStore(); }
export function withExecution<T>(context:ExecutionContext, fn:()=>T):T { return storage.run({context:ExecutionContextSchema.parse(context),events:[],spentUsd:0,active:0},fn); }
export function runEvent(kind:string,name:string,data?:Record<string,unknown>):void {
  const execution=currentExecution(); if(!execution) return;
  // Deliberately metadata only: callers must never emit prompt/args/customer data.
  execution.events.push({id:randomUUID(),taskId:execution.context.taskId,orgId:execution.context.orgId,kind,name,at:Date.now(),...(data?{data}: {})});
}
export function assertExternalAllowed():void {
  const execution=currentExecution(); if(!execution) return;
  if(execution.context.mode==='simulation') throw new Error('simulation_external_denied');
  if(Date.now()>execution.context.deadline) throw new Error('execution_deadline_exceeded');
  if(execution.spentUsd>=execution.context.budgetUsd) throw new Error('execution_budget_exceeded');
}
export async function bounded<T>(fn:()=>Promise<T>):Promise<T> {
  const e=currentExecution(); if(!e) return fn();
  if(e.active>=e.context.maxConcurrency) throw new Error('execution_concurrency_exceeded');
  e.active++; try{return await fn();}finally{e.active--;}
}
export function recordCost(costUsd:number|null):void {
  const e=currentExecution(); if(e && costUsd!==null && Number.isFinite(costUsd)) e.spentUsd+=Math.max(0,costUsd);
}
export function namespaceFor(mode:'simulation'|'staging',orgId:string,phone:string,sessionId:string,subjectDigest?:string):string {
  return `playground:${mode}:${contentDigest({orgId,phone:conversationKey(phone),sessionId,...(subjectDigest?{subjectDigest}:{})})}`;
}
export function liveNamespaceFor(orgId:string,phone:string,subject:unknown):string {return `live:${contentDigest({orgId,phone:conversationKey(phone),subjectDigest:contentDigest(subject)})}`;}
export function scopedThreadId(orgId:string,phone:string):string {
  const e=currentExecution();return e&&e.context.orgId===orgId?e.context.conversationId:`${orgId}:${conversationKey(phone)}`;
}
