import {describe,it,expect,vi,afterEach} from 'vitest';
import {withExecution} from '../context';
import {buildGraph} from '@/graph/graph';
import {fetchWithTimeout} from '../../http';
import {query} from '../../db';
import {consultarEscopo} from '../../scope';
const ctx={orgId:'fixture-org',subject:{kind:'user' as const,userId:'fixture-user'},conversationId:'playground:simulation:fixture',taskId:'11111111-1111-4111-8111-111111111111',mode:'simulation' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+10000,budgetUsd:0,maxConcurrency:3};
afterEach(()=>vi.unstubAllGlobals());
describe('same graph simulation',()=>{
 it('runs the production graph with fixture adapters without network, paid model or application DB accesses',async()=>{
  const fetch=vi.fn(()=>{throw new Error('real network called');});vi.stubGlobal('fetch',fetch);
  const result=await withExecution(ctx,()=>buildGraph().compile().invoke({identity:{orgId:'fixture-org',orgName:'Imobiliária de simulação',kind:'user',userId:'fixture-user',userName:'Pessoa sintética'},inbound:{messageId:'fixture-message',fromPhone:'+5511999990000',kind:'text',text:'como funciona o formulário?',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()}}));
  expect(result.reply).toContain('Simulação');expect(result.timings.map(t=>t.no)).toContain('answer');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('denies raw network and DB escape paths even for GET',async()=>{
  await withExecution(ctx,async()=>{
   await expect(fetchWithTimeout('https://example.test',{},100)).rejects.toThrow('simulation_external_denied');
   await expect(query('DELETE FROM org_config')).rejects.toThrow('simulation_database_denied');
   expect(await consultarEscopo({orgId:'fixture-org',rawPhone:'+5511999990000',subject:ctx.subject,verb:'deal.list'})).toEqual({items:[],truncated:false});
  });
 });
});
