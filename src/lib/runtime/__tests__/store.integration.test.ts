import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../db';
import { executeIntent, startTask, finishTask, getTaskEvents, expireLeases } from '../store';
import { withExecution } from '../context';
const d=process.env.DATABASE_URL?describe:describe.skip;
const ctx={orgId:'runtime-test',subject:{kind:'user' as const,userId:'fixture-user'},conversationId:'fixture-thread',taskId:'11111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+60000,budgetUsd:1,maxConcurrency:3};
d('durable execution',()=>{
 beforeEach(async()=>{await query("DELETE FROM runtime_task WHERE org_id='runtime-test'");});
 it('reserves intent before effect and does not retry an uncertain paid effect, including concurrently',async()=>{
  await startTask(ctx); let calls=0;
  const invoke=()=>withExecution(ctx,()=>executeIntent({verb:'credit.request',key:'request-a',args:{amount:1}},async()=>{calls++; const rows=await query('SELECT state FROM execution_intent WHERE org_id=$1',[ctx.orgId]); expect(rows[0].state).toBe('running'); return null;}));
  const results=await Promise.all([invoke(),invoke()]);
  expect(calls).toBe(1);
  expect(results).toHaveLength(2);
  await invoke(); expect(calls).toBe(1);
  expect((await query('SELECT state FROM execution_intent WHERE org_id=$1',[ctx.orgId]))[0].state).toBe('unknown');
 });
 it('rejects reuse of idempotency key for altered content or another subject',async()=>{
  await startTask(ctx);
  await withExecution(ctx,()=>executeIntent({verb:'form.create',key:'same',args:{title:'A'}},async()=>({status:200,body:{ok:true}})));
  let called=false;
  const changed=await withExecution(ctx,()=>executeIntent({verb:'form.create',key:'same',args:{title:'B'}},async()=>{called=true;return null;}));
  expect(changed?.status).toBe(409); expect(called).toBe(false);
  const other=await withExecution({...ctx,subject:{kind:'user',userId:'another'}},()=>executeIntent({verb:'form.create',key:'same',args:{title:'A'}},async()=>{called=true;return null;}));
  expect(other?.status).toBe(409); expect(called).toBe(false);
 });
 it('expires abandoned leases to unknown and persists trace events',async()=>{
  await startTask(ctx);
  await query("UPDATE runtime_task SET lease_until=now()-interval '1 minute' WHERE id=$1",[ctx.taskId]);
  await expireLeases();
  expect((await query('SELECT state FROM runtime_task WHERE id=$1',[ctx.taskId]))[0].state).toBe('unknown');
  await finishTask(ctx,'succeeded',[{id:'22222222-2222-4222-8222-222222222222',orgId:ctx.orgId,taskId:ctx.taskId,kind:'tool.completed',name:'form.create',at:Date.now()}]);
  expect(await getTaskEvents(ctx.orgId,ctx.taskId)).toHaveLength(1);
  expect(await getTaskEvents('other-org',ctx.taskId)).toHaveLength(0);
 });
});
