import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../../orgs',()=>({orgById:async()=>({orgId:'fixture-org',apiToken:'fixture-token'})}));
vi.mock('../../http',()=>({fetchWithTimeout:async()=>Response.json({snapshot:{source:{private:'SHOULD_NEVER_APPEAR'},events:[{kind:'worker',name:'marketing.qa',version:'1',skill:'marketing-factual-qa-v1',model:null,status:'succeeded',revision:0,occurredAt:'2026-10-20T12:00:00.000Z',metadata:{checks:['official_facts','safe_artwork','SHOULD_NEVER_APPEAR'],issueCodes:[],source:'SHOULD_NEVER_APPEAR'},args:'SHOULD_NEVER_APPEAR'},{kind:'worker',name:'unknown-private-stage',status:'succeeded'}]}}),imobproBase:()=> 'https://fixture.test',IMOBPRO_TIMEOUT_MS:8000,IMOBPRO_PROPOSAL_SEND_TIMEOUT_MS:30000,IMOBPRO_CREDIT_REQUEST_TIMEOUT_MS:30000,captacaoSendTimeoutMs:()=>30000}));
import {executarAcao} from '../../acao';
import {withExecution,currentExecution} from '../context';
import {catalog} from '../catalog';
const ctx={orgId:'fixture-org',subject:{kind:'user' as const,userId:'fixture'},conversationId:'fixture',taskId:'11111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+10000,budgetUsd:1,maxConcurrency:3};
afterEach(()=>vi.unstubAllEnvs());
describe('remote marketing pipeline trace boundary',()=>{
 it('imports real-format worker results through the action gateway with only reviewed metadata',async()=>{
  vi.stubEnv('MAX_MARKETING','true');
  await withExecution(ctx,async()=>{
   await executarAcao({orgId:ctx.orgId,rawPhone:'+5511999990000',subject:ctx.subject,verb:'marketing.options',args:{}});
   const events=currentExecution()!.events;
   expect(events.some(e=>e.kind==='worker.completed'&&e.name==='marketing.qa'&&e.data?.outcome==='succeeded')).toBe(true);
   expect(JSON.stringify(events)).not.toContain('SHOULD_NEVER_APPEAR');
   expect(JSON.stringify(events)).not.toContain('unknown-private-stage');
   expect(events.find(e=>e.name==='marketing.qa')?.data?.checks).toEqual(['official_facts','safe_artwork']);
  });
 });
 it('declares actual installed remote workers while keeping them disabled in simulation rollout',()=>{
  const workers=catalog().agents.filter(a=>'owner' in a&&a.owner==='ImobPro');
  expect(workers.map(w=>w.id)).toEqual(['marketing.brief','marketing.copy-script','marketing.template-layout','marketing.qa','marketing.video']);
  expect(workers.every(w=>w.installed&&w.status==='disabled')).toBe(true);
 });
});
