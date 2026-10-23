import {describe,it,expect,vi,afterEach} from 'vitest';
import {NextRequest} from 'next/server';
import {POST,GET} from '@/app/api/admin/playground/route';
import {query} from '../../db';
import {sign} from '../../hmac';
const d=process.env.DATABASE_URL?describe:describe.skip;
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
d('playground real graph and durable history',()=>{
 it('persists an isolated synthetic session and refuses cross-person reuse without real side effects',async()=>{
  vi.stubEnv('MAX_PLAYGROUND','true');vi.stubEnv('MAX_NOTIFY_SECRET','fixture');vi.stubGlobal('fetch',()=>{throw new Error('real network forbidden');});
  const body={orgId:'playground-e2e-fixture',phone:'+5511999990000',sessionId:'91111111-1111-4111-8111-111111111111',requestId:'81111111-1111-4111-8111-111111111111',mode:'simulation',text:'Como funciona o formulário?'};
  await query('DELETE FROM runtime_task WHERE org_id=$1',[body.orgId]);await query('DELETE FROM playground_session WHERE id=$1',[body.sessionId]);
  const raw=JSON.stringify(body),ts=String(Date.now()),path='/api/admin/playground';
  const response=await POST(new NextRequest(`https://fixture.test${path}`,{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture')}}));expect(response.status).toBe(200);
  const result=await response.json();expect(result.threadId).toMatch(/^playground:simulation:/);expect(result.reply).toContain('Simulação');expect(result.traces.some((e:{kind:string})=>e.kind==='model.simulated')).toBe(true);
  expect(result.agentKey).toBe('max');expect(result.traces.find((e:{kind:string})=>e.kind==='run.started').name).toBe('max');
  const params=new URLSearchParams({orgId:body.orgId,phone:body.phone,sessionId:body.sessionId,mode:'simulation'}),getPath=`${path}?${params}`;
  const history=await GET(new NextRequest(`https://fixture.test${getPath}`,{headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,`GET.${getPath}`,'fixture')}}));expect(history.status).toBe(200);expect((await history.json()).messages).toHaveLength(2);
  const changed=JSON.stringify({...body,phone:'+5511999990001',requestId:'71111111-1111-4111-8111-111111111111'});
  expect((await POST(new NextRequest(`https://fixture.test${path}`,{method:'POST',body:changed,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,changed,'fixture')}}))).status).toBe(409);
  expect(await query('SELECT 1 FROM conversation_turn WHERE org_id=$1',[body.orgId])).toHaveLength(0);
  expect(await query('SELECT 1 FROM memory_facts WHERE org_id=$1',[body.orgId])).toHaveLength(0);
 });
 it('perfil newton: o playground roda e se identifica como newton',async()=>{
  vi.stubEnv('AGENT_DEPLOY_PROFILE','newton');vi.stubEnv('MAX_PLAYGROUND','true');vi.stubEnv('MAX_NOTIFY_SECRET','fixture');vi.stubGlobal('fetch',()=>{throw new Error('real network forbidden');});
  const body={orgId:'playground-newton-fixture',phone:'+5511999990002',sessionId:'92222222-2222-4222-8222-222222222222',requestId:'82222222-2222-4222-8222-222222222222',mode:'simulation',text:'Quais negócios tenho?'};
  await query('DELETE FROM runtime_task WHERE org_id=$1',[body.orgId]);await query('DELETE FROM playground_session WHERE id=$1',[body.sessionId]);
  const raw=JSON.stringify(body),ts=String(Date.now()),path='/api/admin/playground';
  const response=await POST(new NextRequest(`https://fixture.test${path}`,{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture')}}));expect(response.status).toBe(200);
  const result=await response.json();expect(result.agentKey).toBe('newton');
  expect(result.traces.filter((e:{kind:string})=>e.kind.startsWith('run.')).map((e:{name:string})=>e.name)).toEqual(['newton','newton']);
  expect(await query('SELECT 1 FROM outbox WHERE org_id=$1',[body.orgId])).toHaveLength(0);
 });
});
