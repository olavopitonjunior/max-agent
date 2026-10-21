import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {query} from '../../db';
import {loadFacts,saveFacts,pruneOldFacts} from '../../memory';
import {withExecution} from '../context';
import {contentDigest} from '../contracts';
const d=process.env.DATABASE_URL?describe:describe.skip;
const org='memory-provenance-fixture',phone='5511999990088';
const base={orgId:org,subject:{kind:'user' as const,userId:'subject-a'},conversationId:`${org}:${phone}`,taskId:'61111111-1111-4111-8111-111111111111',mode:'live' as const,workflowVersion:'max-v1',controlVersion:0,deadline:Date.now()+60000,budgetUsd:1,maxConcurrency:3};
afterEach(()=>vi.unstubAllEnvs());
d('runtime preference provenance',()=>{
 beforeEach(async()=>{await query('DELETE FROM memory_facts WHERE org_id=$1',[org]);});
 it('derives provenance from the trusted context and never reads legacy or another subject',async()=>{
  await saveFacts(org,phone,{legacy:'Preferência antiga'});
  await withExecution(base,async()=>{expect(await loadFacts(org,phone)).toEqual({});await saveFacts(org,phone,{foco:'Locação'});expect(await loadFacts(org,phone)).toEqual({foco:'Locação'});});
  const [row]=await query('SELECT source_task_id,workflow_version,subject_digest FROM memory_facts WHERE org_id=$1 AND subject_digest=$2',[org,contentDigest(base.subject)]);
  expect(row).toEqual({source_task_id:base.taskId,workflow_version:'max-v1',subject_digest:contentDigest(base.subject)});
  await withExecution({...base,subject:{kind:'user',userId:'subject-b'}},async()=>{expect(await loadFacts(org,phone)).toEqual({});await saveFacts(org,phone,{tratamento:'Doutor'});expect(await loadFacts(org,phone)).toEqual({tratamento:'Doutor'});});
  await withExecution(base,async()=>expect(await loadFacts(org,phone)).toEqual({foco:'Locação'}));
  expect(await loadFacts(org,phone)).toEqual({legacy:'Preferência antiga'});
 });
 it('refuses caller tenant or person substitutions and preserves TTL pruning',async()=>{
  await withExecution({...base,personDigest:contentDigest(phone),privacyEpoch:0},async()=>{
   expect(await saveFacts('other-org',phone,{foco:'Vendas'})).toBe(0);
   expect(await saveFacts(org,'5511999990089',{foco:'Vendas'})).toBe(0);
   await saveFacts(org,phone,{foco:'Locação'});
  });
  await query("UPDATE memory_facts SET updated_at=now()-interval '200 days' WHERE org_id=$1",[org]);
  vi.stubEnv('MEMORY_TTL_DAYS','180');await pruneOldFacts();
  await withExecution(base,async()=>expect(await loadFacts(org,phone)).toEqual({}));
  expect(await query('SELECT 1 FROM memory_facts WHERE org_id=$1',[org])).toHaveLength(0);
 });
 it('keeps the same preference key independent for two subjects sharing a phone',async()=>{
  await withExecution(base,()=>saveFacts(org,phone,{foco:'Locação'}));
  const other={...base,subject:{kind:'user' as const,userId:'subject-b'}};
  await withExecution(other,()=>saveFacts(org,phone,{foco:'Vendas'}));
  await withExecution(base,async()=>expect(await loadFacts(org,phone)).toEqual({foco:'Locação'}));
  await withExecution(other,async()=>expect(await loadFacts(org,phone)).toEqual({foco:'Vendas'}));
 });

});
