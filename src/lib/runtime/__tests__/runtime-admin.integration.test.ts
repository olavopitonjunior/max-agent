import {describe,it,expect,beforeEach,vi,afterEach} from 'vitest';
import {NextRequest} from 'next/server';
import {query,db} from '../../db';
import {startTask,executeIntent} from '../store';
import {withExecution} from '../context';
import {transitionControl} from '../handoff';
import {sign} from '../../hmac';
import {POST,GET} from '@/app/api/admin/runtime/route';
const d=process.env.DATABASE_URL?describe:describe.skip;
const ctx={orgId:'cancel-fixture',subject:{kind:'user' as const,userId:'fixture'},conversationId:'fixture',taskId:'c1111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+60000,budgetUsd:1,maxConcurrency:3};
function req(orgId=ctx.orgId){const raw=JSON.stringify({orgId,taskId:ctx.taskId,operation:'cancel',expectedState:'queued',actorId:'admin'}),ts=String(Date.now());return new NextRequest('https://fixture.test/api/admin/runtime',{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture')}});}
afterEach(()=>vi.unstubAllEnvs());
d('cancel queued task atomic boundary',()=>{
 beforeEach(async()=>{vi.stubEnv('MAX_NOTIFY_SECRET','fixture');await query('DELETE FROM execution_intent WHERE org_id=$1',[ctx.orgId]);await query('DELETE FROM runtime_task WHERE org_id=$1',[ctx.orgId]);await startTask(ctx);});
 it('does not cancel running work or another tenant and never repeats effect after cancelled',async()=>{
  expect((await POST(req())).status).toBe(409);
  await query("UPDATE runtime_task SET state='queued' WHERE id=$1",[ctx.taskId]);
  expect((await POST(req('other-org'))).status).toBe(409);
  expect((await POST(req())).status).toBe(200);
  let called=false;await withExecution(ctx,()=>executeIntent({verb:'credit.request',key:'fixture-request',args:{}},async()=>{called=true;return null;}));expect(called).toBe(false);
 });
 it('cannot cancel task with reserved unknown effect',async()=>{
  await withExecution(ctx,()=>executeIntent({verb:'credit.request',key:'fixture',args:{}},async()=>null));
  await query("UPDATE runtime_task SET state='queued' WHERE id=$1",[ctx.taskId]);
  expect((await POST(req())).status).toBe(409);
 });
 it('waits for an in-flight reservation then uses a fresh snapshot before cancellation',async()=>{
  await query("UPDATE runtime_task SET state='queued' WHERE id=$1",[ctx.taskId]);
  const client=await db().connect();await client.query('BEGIN');
  try {
   await client.query('SELECT id FROM runtime_task WHERE id=$1 FOR UPDATE',[ctx.taskId]);
   await client.query(`INSERT INTO execution_intent(id,task_id,org_id,idempotency_key,verb,content_digest,subject_digest,state) VALUES('e1111111-1111-4111-8111-111111111111',$1,$2,'race','credit.request','digest','subject','running')`,[ctx.taskId,ctx.orgId]);
   const pending=POST(req());
   // Ensure the cancellation is waiting on the real row lock before release.
   for(let i=0;i<100;i++){const waiting=await query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM runtime_task%'");if(waiting.length)break;await new Promise(r=>setTimeout(r,5));}
   await client.query('COMMIT');expect((await pending).status).toBe(409);
  }finally{await client.query('ROLLBACK');client.release();}
 });

 it('alerts for an unclaimed waiting handoff and clears the alert after an atomic claim',async()=>{
  const phone='5511999990688';await query('DELETE FROM conversation_control WHERE org_id=$1',[ctx.orgId]);
  await transitionControl({orgId:ctx.orgId,phone,operation:'request',actorId:'requester'});
  const path=`/api/admin/runtime?orgId=${ctx.orgId}`,ts=String(Date.now());
  const status=async()=>{const response=await GET(new NextRequest(`https://fixture.test${path}`,{headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,`GET.${path}`,'fixture')}}));return response.json();};
  expect((await status()).summary).toMatchObject({handoffNoOwner:1,alertHandoffNoOwner:true});
  await transitionControl({orgId:ctx.orgId,phone,operation:'claim',actorId:'owner',controlVersion:1});expect((await status()).summary).toMatchObject({handoffNoOwner:0,alertHandoffNoOwner:false});
 });

});
