import {describe,it,expect,vi,afterEach} from 'vitest';
import {withExecution,recordCost} from '../context';
import {fetchWithTimeout} from '../../http';
const ctx={orgId:'fixture-org',subject:{kind:'user' as const,userId:'fixture'},conversationId:'fixture',taskId:'11111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+10000,budgetUsd:0.01,maxConcurrency:3};
afterEach(()=>vi.unstubAllGlobals());
describe('shared execution limits',()=>{
 it('blocks fourth concurrent upstream before opening a connection',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);let calls=0;vi.stubGlobal('fetch',async()=>{calls++;await hold;return Response.json({});});
  await withExecution(ctx,async()=>{
   const pending=[1,2,3].map(()=>fetchWithTimeout('https://fixture.test',{},1000));
   await expect(fetchWithTimeout('https://fixture.test',{},1000)).rejects.toThrow('execution_concurrency_exceeded');expect(calls).toBe(3);release();await Promise.all(pending);
  });
 });
 it('blocks expired or exhausted executions before network',async()=>{
  vi.stubGlobal('fetch',()=>{throw new Error('network should remain closed');});
  await withExecution({...ctx,deadline:Date.now()-1},async()=>{await expect(fetchWithTimeout('https://fixture.test',{},1000)).rejects.toThrow('execution_deadline_exceeded');});
  await withExecution(ctx,async()=>{recordCost(0.01);await expect(fetchWithTimeout('https://fixture.test',{},1000)).rejects.toThrow('execution_budget_exceeded');});
 });
});
