import {describe,it,expect,beforeEach,vi,afterEach} from 'vitest';
import {query} from '../../db';
import {contentDigest} from '../contracts';
import {withExecution} from '../context';
import {privacyEpoch,withPrivacyFence,protectCheckpoint} from '../privacy';
import {transitionControl} from '../handoff';
import {startTask,bindPlaygroundSession} from '../store';
import {namespaceFor} from '../context';
import {invokeIsolatedGraph} from '@/graph/graph';
import {POST as forget} from '@/app/api/admin/forget/route';
import {NextRequest} from 'next/server';
import {sign} from '../../hmac';
const d=process.env.DATABASE_URL?describe:describe.skip;
const personDigest=contentDigest('5511999990099');
afterEach(()=>vi.unstubAllEnvs());
d('privacy epoch fencing',()=>{
 beforeEach(async()=>{await query('DELETE FROM runtime_privacy_epoch WHERE person_digest=$1',[personDigest]);});
 it('denies writes from context captured before erasure, allows a genuinely new context',async()=>{
  const epoch=await privacyEpoch(personDigest);expect(epoch).toBe(0);
  const ctx={orgId:'privacy-fixture',subject:{kind:'user' as const,userId:'fixture'},conversationId:'privacy',taskId:'11111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+1000,budgetUsd:1,maxConcurrency:3,personDigest,privacyEpoch:epoch};
  await query('INSERT INTO runtime_privacy_epoch(person_digest,epoch) VALUES($1,1)',[personDigest]);
  let called=false;
  await expect(withPrivacyFence(ctx,async()=>{called=true;})).rejects.toThrow('execution_revoked');expect(called).toBe(false);
  await expect(withExecution(ctx,()=>query("SELECT 1"))).rejects.toThrow('execution_revoked');
  expect(await withPrivacyFence({...ctx,privacyEpoch:await privacyEpoch(personDigest)},async()=>true)).toBe(true);
 });
 it('erases playground checkpoints and derivatives, rejects a late graph callback without resurrection',async()=>{
  const phone='5511999990099',sessionId='f1111111-1111-4111-8111-111111111111',taskId='b1111111-1111-4111-8111-111111111111';
  await query('DELETE FROM runtime_task WHERE id=$1',[taskId]);await query('DELETE FROM playground_session WHERE id=$1',[sessionId]);
  const ctx={orgId:'privacy-fixture',subject:{kind:'user' as const,userId:'fixture'},conversationId:namespaceFor('simulation','privacy-fixture',phone,sessionId),taskId,mode:'simulation' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+10000,budgetUsd:0,maxConcurrency:3,personDigest,privacyEpoch:0};
  await startTask(ctx);await bindPlaygroundSession(sessionId,ctx.orgId,phone,ctx.mode,ctx);
  const identity={kind:'user' as const,userId:'fixture',userName:'Synthetic',orgId:ctx.orgId,orgName:'Synthetic'};
  const inbound={messageId:'privacy-fixture-message',fromPhone:phone,kind:'text' as const,text:'como funciona o formulário?',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()};
  await withExecution(ctx,()=>invokeIsolatedGraph(inbound,identity,ctx.conversationId));
  expect((await query('SELECT 1 FROM checkpoints WHERE thread_id=$1',[ctx.conversationId])).length).toBeGreaterThan(0);
  vi.stubEnv('MAX_NOTIFY_SECRET','privacy-fixture');const raw=JSON.stringify({phone}),ts=String(Date.now());
  const result=await forget(new NextRequest('https://fixture.test/api/admin/forget',{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'privacy-fixture')}}));expect(result.status).toBe(200);
  expect(await query('SELECT id FROM runtime_task WHERE id=$1',[taskId])).toHaveLength(0);
  expect(await query('SELECT 1 FROM checkpoints WHERE thread_id=$1',[ctx.conversationId])).toHaveLength(0);
  await expect(withExecution(ctx,()=>invokeIsolatedGraph({...inbound,messageId:'late-callback'},identity,ctx.conversationId))).rejects.toThrow('execution_revoked');
  expect(await query('SELECT 1 FROM checkpoints WHERE thread_id=$1',[ctx.conversationId])).toHaveLength(0);
 });

 it('fences late bot checkpoints after human takeover',async()=>{
  const phone='5511999990099';await query('DELETE FROM conversation_control WHERE org_id=$1',['privacy-fixture']);
  await transitionControl({orgId:'privacy-fixture',phone,operation:'request',actorId:'human'});
  const ctx={orgId:'privacy-fixture',subject:{kind:'user' as const,userId:'fixture'},conversationId:`privacy-fixture:${phone}`,taskId:'a1111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+10000,budgetUsd:1,maxConcurrency:3,personDigest,privacyEpoch:0};
  let wrote=false;await expect(withExecution(ctx,()=>protectCheckpoint(async()=>{wrote=true;}))).rejects.toThrow('control_conflict');expect(wrote).toBe(false);
 });

});
