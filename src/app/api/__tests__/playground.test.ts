import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {NextRequest} from 'next/server';
import {sign} from '@/lib/hmac';
vi.mock('@/graph/graph',()=>({invokeIsolatedGraph:vi.fn(async()=>({reply:'fixture',toolLog:[],usage:[],timings:[]}))}));
vi.mock('@/lib/runtime/privacy',()=>({privacyEpoch:vi.fn(async()=>0)}));
vi.mock('@/lib/identity',()=>({resolveIdentity:vi.fn()}));
vi.mock('@/lib/runtime/store',()=>({bindPlaygroundSession:vi.fn(async()=>true),startTask:vi.fn(async()=>true),finishTask:vi.fn(async()=>{})}));
vi.mock('@/lib/runtime/playground',async original=>({...await original<typeof import('@/lib/runtime/playground')>(),savePlaygroundMessage:vi.fn(async()=>{}),playgroundHistory:vi.fn(async()=>({messages:[],tasks:[]}))}));
vi.mock('@/lib/checkpointer-reset',()=>({limparThreadDoCheckpointer:vi.fn(async()=>{})}));
const {POST}=await import('@/app/api/admin/playground/v1/route');
const {resolveIdentity}=await import('@/lib/identity');
const {limparThreadDoCheckpointer}=await import('@/lib/checkpointer-reset');
const {bindPlaygroundSession,startTask}=await import('@/lib/runtime/store');
const body={orgId:'org-1',phone:'+5511999990000',sessionId:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',text:'oi'};
function req(data:unknown,signed=true){const raw=JSON.stringify(data),ts=String(Date.now());return new NextRequest('https://max.test/api/admin/playground/v1',{method:'POST',body:raw,headers:signed?{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture-secret')}:{}});}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('MAX_NOTIFY_SECRET','fixture-secret');vi.stubEnv('MAX_PLAYGROUND','true');vi.mocked(bindPlaygroundSession).mockResolvedValue(true);vi.mocked(startTask).mockResolvedValue(true);});afterEach(()=>vi.unstubAllEnvs());
describe('isolated playground route',()=>{
 it('keeps environment gate before HMAC',async()=>{vi.stubEnv('MAX_PLAYGROUND','false');expect((await POST(req(body,false))).status).toBe(404);});
 it('requires valid HMAC',async()=>{expect((await POST(req(body,false))).status).toBe(401);});
 it.each([{...body,sessionId:undefined},{...body,phone:'invalid'},{...body,requestId:'invalid'},{...body,text:undefined}])('rejects invalid contract without identity or reset',async data=>{expect((await POST(req(data))).status).toBe(400);expect(resolveIdentity).not.toHaveBeenCalled();expect(limparThreadDoCheckpointer).not.toHaveBeenCalled();});
 it('simulation never resolves real identity and returns isolated namespace and traces',async()=>{const response=await POST(req(body));expect(response.status).toBe(200);const result=await response.json();expect(result.threadId).toMatch(/^playground:simulation:/);expect(result.mode).toBe('simulation');expect(result.sessionId).toBe(body.sessionId);expect(Array.isArray(result.traces)).toBe(true);expect(resolveIdentity).not.toHaveBeenCalled();});
 it('reset cannot target a real conversation',async()=>{const response=await POST(req({...body,novo:true,text:undefined}));expect(response.status).toBe(200);const thread=vi.mocked(limparThreadDoCheckpointer).mock.calls[0][0];expect(thread).toMatch(/^playground:simulation:/);expect(thread).not.toBe('org-1:5511999990000');});
 it('denies staging outside synthetic allowlist before resolving identity',async()=>{expect((await POST(req({...body,mode:'staging'}))).status).toBe(403);expect(resolveIdentity).not.toHaveBeenCalled();});
 it('rejects session reused across tenant/person/mode',async()=>{vi.mocked(bindPlaygroundSession).mockResolvedValue(false);expect((await POST(req(body))).status).toBe(409);});
 it('reserves request atomically before reset/graph invocation',async()=>{vi.mocked(startTask).mockResolvedValue(false);expect((await POST(req({...body,novo:true}))).status).toBe(409);expect(limparThreadDoCheckpointer).not.toHaveBeenCalled();});
 it('staging validates resolved tenant before binding session',async()=>{vi.stubEnv('MAX_PLAYGROUND_STAGING_IDENTITIES',JSON.stringify([{orgId:body.orgId,phone:body.phone}]));vi.mocked(resolveIdentity).mockResolvedValue({kind:'unknown'});expect((await POST(req({...body,mode:'staging'}))).status).toBe(409);expect(bindPlaygroundSession).not.toHaveBeenCalled();});
});
