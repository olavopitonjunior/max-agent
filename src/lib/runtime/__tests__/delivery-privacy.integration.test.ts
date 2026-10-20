import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {NextRequest} from 'next/server';
import {Client} from 'pg';
const scheduled=vi.hoisted(()=>({pause:null as null|(()=>Promise<void>),afterReplyPause:null as null|(()=>Promise<void>),subject:'subject-a'}));
vi.mock('@/graph/graph',async original=>{const actual=await original<typeof import('@/graph/graph')>();return {...actual,runTurn:async(...args:Parameters<typeof actual.runTurn>)=>{const result=await actual.runTurn(...args);if(scheduled.pause)await scheduled.pause();return {...result,afterReply:async()=>{if(scheduled.afterReplyPause)await scheduled.afterReplyPause();return result.afterReply();}};}};});
vi.mock('@/lib/identity',async original=>({...await original<typeof import('@/lib/identity')>(),resolveIdentity:async()=>({kind:'resolved',org:{orgId:'delivery-privacy-fixture',orgName:'Fixture',apiToken:'fixture'},candidate:{kind:'user',orgId:'delivery-privacy-fixture',orgName:'Fixture',userId:scheduled.subject,userName:'Synthetic'}})}));
vi.mock('@/lib/cm',async original=>({...await original<typeof import('@/lib/cm')>(),fetchProfile:async()=>({enabled:true,model:'fixture',maxPolicy:{byRole:{admin:['form.create','proposal.create']}}}),chaveDePolitica:async()=> 'admin',searchKnowledge:async()=>[],reportUsage:async()=>{},criarFormularioVenda:vi.fn(async()=>({token:'fixture-created',dealId:'fixture-deal',url:'https://fixture.test/created'})),brokerRecipientId:async()=>null}));
vi.mock('@/lib/llm',async original=>({...await original<typeof import('@/lib/llm')>(),complete:async()=>({text:'Resposta sintética.',toolCalls:[],usage:{model:'fixture',promptTokens:1,completionTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0,latencyMs:0,success:true}})}));
vi.mock('@/lib/transport',()=>({sendText:vi.fn(async()=>({messageId:'fixture-reply'})),connectionStatus:async()=>({connected:true}),provider:()=> 'meta',sendTemplate:vi.fn(async()=>({messageId:'fixture-template'}))}));
const {query}=await import('../../db');
const database=await import('../../db');
const {enqueue,dispatchDue}=await import('../../outbox');
const {runQueued,enqueueInbound}=await import('../../inbound');
const {runTurn,getApp,buildGraph}=await import('@/graph/graph');
const {liveNamespaceFor}=await import('../context');
const {transitionControl}=await import('../handoff');
const {POST:handoff}=await import('@/app/api/admin/handoff/route');
const {sendText}=await import('../../transport');
const {POST:forget}=await import('@/app/api/admin/forget/route');
const {sign}=await import('../../hmac');
const {contentDigest}=await import('../contracts');
const d=process.env.DATABASE_URL?describe:describe.skip;
const phone='5511999990700',org='delivery-privacy-fixture';
async function erase(){const raw=JSON.stringify({phone}),ts=String(Date.now());expect((await forget(new NextRequest('https://fixture.test/api/admin/forget',{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture-secret')}}))).status).toBe(200);}
async function inbound(id:string){await enqueueInbound({messageId:id,fromPhone:phone,kind:'text',text:'Como funciona o formulário?',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()});return (await query('SELECT * FROM inbound_queue WHERE message_id=$1',[id]))[0];}
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();scheduled.pause=null;scheduled.afterReplyPause=null;});
d('durable graph-to-delivery privacy boundary',()=>{
 beforeEach(async()=>{scheduled.pause=null;scheduled.afterReplyPause=null;scheduled.subject='subject-a';vi.clearAllMocks();vi.stubEnv('MAX_RUNTIME_V1','true');vi.stubEnv('MAX_HANDOFF','true');vi.stubEnv('MAX_NOTIFY_SECRET','fixture-secret');await query('DELETE FROM runtime_privacy_epoch WHERE person_digest=$1',[contentDigest(phone)]);await query('DELETE FROM runtime_task WHERE org_id=$1',[org]);await query('DELETE FROM conversation_control WHERE org_id=$1',[org]);await query('DELETE FROM conversation_turn WHERE org_id=$1',[org]);await query('DELETE FROM inbound_queue WHERE from_phone=$1',[phone]);await query('DELETE FROM live_conversation_binding WHERE org_id=$1',[org]);});
 it('does not persist or send a graph reply after forget commits before queue handoff',async()=>{
  const row=await inbound('delivery-forget-after-graph');let graphDone!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>graphDone=r),hold=new Promise<void>(r=>release=r);scheduled.pause=async()=>{graphDone();await hold;};
  const work=runQueued(row as never);await reached;await erase();release();expect(await work).toBe('done');
  expect(sendText).not.toHaveBeenCalled();expect(await query('SELECT 1 FROM conversation_control WHERE org_id=$1',[org])).toHaveLength(0);expect(await query('SELECT 1 FROM conversation_turn WHERE org_id=$1',[org])).toHaveLength(0);
 });
 it('refuses replay of a durable reply captured before erasure',async()=>{
  const row=await inbound('delivery-forget-persisted');vi.mocked(sendText).mockRejectedValueOnce(new Error('fixture known transport failure'));
  expect(await runQueued(row as never)).toBe('retry');const [saved]=await query('SELECT * FROM inbound_queue WHERE message_id=$1',['delivery-forget-persisted']);expect(saved.reply_text).toBeTruthy();
  await erase();vi.mocked(sendText).mockClear();expect(await runQueued(saved as never)).toBe('done');expect(sendText).not.toHaveBeenCalled();expect(await query('SELECT 1 FROM conversation_control WHERE org_id=$1',[org])).toHaveLength(0);
 });
 it('isolates checkpoints and pending approvals when the same phone resolves to a new subject; handback and forget cover both',async()=>{
  const a=await runTurn({messageId:'subject-a-turn',fromPhone:phone,kind:'text',text:'oi',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()});await a.afterReply();
  const app=await getApp(),threadA=a.dispatchFence!.conversationId!;
  await app.updateState({configurable:{thread_id:threadA}},{messages:[{role:'assistant',content:'PRIVATE_A_ONLY'}],pendingAction:{kind:'criar_documento',args:{tipo:'venda'},askedAt:Date.now(),askedForMessageId:'subject-a-approval'}});
  scheduled.subject='subject-b';const b=await runTurn({messageId:'subject-b-turn',fromPhone:phone,kind:'text',text:'sim',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()});
  const threadB=b.dispatchFence!.conversationId!;expect(threadB).not.toBe(threadA);const state=await app.getState({configurable:{thread_id:threadB}});expect(JSON.stringify(state.values)).not.toContain('PRIVATE_A_ONLY');expect(state.values.pendingAction).toBeNull();
  await transitionControl({orgId:org,phone,operation:'request',actorId:'human'});await transitionControl({orgId:org,phone,operation:'claim',actorId:'human',controlVersion:1});
  const raw=JSON.stringify({orgId:org,phone:`+${phone}`,operation:'handback',actorId:'human',controlVersion:2,requestId:'51111111-1111-4111-8111-111111111111'}),ts=String(Date.now());expect((await handoff(new NextRequest('https://fixture.test/api/admin/handoff',{method:'POST',body:raw,headers:{'x-max-timestamp':ts,'x-max-signature':sign(ts,raw,'fixture-secret')}}))).status).toBe(200);
  expect((await app.getState({configurable:{thread_id:threadA}})).values.pendingAction).toBeNull();await erase();expect(await query('SELECT 1 FROM checkpoints WHERE thread_id=ANY($1)',[[threadA,threadB]])).toHaveLength(0);expect(await query('SELECT 1 FROM live_conversation_binding WHERE org_id=$1',[org])).toHaveLength(0);
 });
 it('applies chat and legacy creation emergency switches with every new feature OFF',async()=>{
  vi.stubEnv('MAX_RUNTIME_V1','false');vi.stubEnv('MAX_HANDOFF','false');vi.stubEnv('MAX_MARKETING','false');vi.stubEnv('MAX_CHAT_KILL','true');
  const msg={messageId:'legacy-kill',fromPhone:phone,kind:'text' as const,text:'sim',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()};expect((await runTurn(msg)).reply).toBeNull();
  vi.stubEnv('MAX_CHAT_KILL','false');vi.stubEnv('MAX_WRITES_KILL','true');
  const result=await buildGraph().compile().invoke({identity:{kind:'user',orgId:org,orgName:'Fixture',userId:'subject-a',userName:'Synthetic'},inbound:msg,pendingAction:{kind:'criar_documento',args:{tipo:'venda'},askedAt:Date.now(),askedForMessageId:'previous'}});expect(result.toolLog.some(t=>t.outcome==='falhou')).toBe(true);expect(result.reply).not.toContain('fixture.test/created');
 });
 it('serializes an in-flight final transport before erasure without resurrecting state',async()=>{
  const row=await inbound('delivery-inflight-lock');let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);vi.mocked(sendText).mockImplementationOnce(async()=>{entered();await hold;return {messageId:'sent-before-erasure'};});
  const work=runQueued(row as never);await reached;const durableMarker=(await query('SELECT last_send_started_at FROM inbound_queue WHERE id=$1',[row.id]))[0].last_send_started_at;let erased=false;const erasing=erase().then(()=>erased=true);await new Promise(r=>setTimeout(r,20));expect(erased).toBe(false);release();await Promise.race([Promise.all([work,erasing]),new Promise((_,reject)=>setTimeout(()=>reject(new Error('dispatch/forget lock timeout')),3000))]);expect(await query('SELECT 1 FROM inbound_queue WHERE from_phone=$1',[phone])).toHaveLength(0);expect(durableMarker).not.toBeNull();
 });
 it('uses one privacy-before-control lock order for takeover concurrent with forget',async()=>{
  let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const takeover=transitionControl({orgId:org,phone,operation:'request',actorId:'human',beforeTransition:async()=>{entered();await hold;}});await reached;const erasing=erase();release();await Promise.race([Promise.all([takeover,erasing]),new Promise((_,reject)=>setTimeout(()=>reject(new Error('takeover/forget lock timeout')),3000))]);expect(await query('SELECT 1 FROM conversation_control WHERE org_id=$1',[org])).toHaveLength(0);
 });

 it('does not send an outbox row erased after claim but before the final transport fence',async()=>{
  await inbound('outbox-window-fixture');await query('DELETE FROM outbox WHERE org_id=$1',[org]);
  const queued=await enqueue({orgId:org,dedupeKey:'outbox-forget-fixture',audience:'platform_user',phone,recipientName:'Synthetic',title:'Synthetic',body:'Synthetic fixture',linkUrl:null,dealId:null,orgName:'Fixture',kind:'welcome'});await query("UPDATE outbox SET deliver_after='2000-01-01' WHERE id=$1",[queued.id]);
  let reached!:()=>void,release!:()=>void;const marker=new Promise<void>(r=>reached=r),hold=new Promise<void>(r=>release=r);const original=database.query;
  vi.spyOn(database,'query').mockImplementation(async(sql:string,args?:unknown[])=>{const result=await original(sql,args);if(sql.includes('UPDATE outbox SET send_started_at')){reached();await hold;}return result;});
  const work=dispatchDue(1,{connected:true} as never);await marker;await erase();release();await work;expect(sendText).not.toHaveBeenCalled();expect(await query('SELECT 1 FROM outbox WHERE id=$1',[queued.id])).toHaveLength(0);
 });

 it('does not resend inbound after provider ACK followed by a fence COMMIT failure',async()=>{
  const row=await inbound('inbound-ack-commit-failure');let failCommit=false;
  const original=Client.prototype.query;
  vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){if(args[0]==='COMMIT'&&failCommit){failCommit=false;throw new Error('fixture COMMIT connection loss');}return Reflect.apply(original,this,args);} as typeof original);
  vi.mocked(sendText).mockImplementationOnce(async()=>{failCommit=true;return {messageId:'provider-accepted-inbound'};});
  await runQueued(row as never);const [saved]=await query('SELECT * FROM inbound_queue WHERE id=$1',[row.id]);
  expect(saved.last_send_started_at).not.toBeNull();await runQueued(saved as never);expect(sendText).toHaveBeenCalledTimes(1);
 });
 it('does not resend outbox after provider ACK followed by a fence COMMIT failure',async()=>{
  await inbound('outbox-ack-window');await query('DELETE FROM outbox WHERE org_id=$1',[org]);
  const queued=await enqueue({orgId:org,dedupeKey:'outbox-ack-commit',audience:'platform_user',phone,recipientName:'Synthetic',title:'Synthetic',body:'Synthetic',linkUrl:null,dealId:null,orgName:'Fixture',kind:'welcome'});await query("UPDATE outbox SET deliver_after='2000-01-01' WHERE id=$1",[queued.id]);
  let failCommit=false;const original=Client.prototype.query;
  vi.spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){if(args[0]==='COMMIT'&&failCommit){failCommit=false;throw new Error('fixture COMMIT connection loss');}return Reflect.apply(original,this,args);} as typeof original);
  vi.mocked(sendText).mockImplementationOnce(async()=>{failCommit=true;return {messageId:'provider-accepted-outbox'};});
  await dispatchDue(1,{connected:true} as never);const [saved]=await query('SELECT * FROM outbox WHERE id=$1',[queued.id]);expect(saved.send_started_at).not.toBeNull();
  await query("UPDATE outbox SET last_attempt_at='2000-01-01',deliver_after='2000-01-01' WHERE id=$1",[queued.id]);await dispatchDue(1,{connected:true} as never);expect(sendText).toHaveBeenCalledTimes(1);
 });
 it('forgets a directly invoked default-OFF live namespace before the same subject reloads',async()=>{
  vi.stubEnv('MAX_RUNTIME_V1','false');vi.stubEnv('MAX_HANDOFF','false');vi.stubEnv('MAX_MARKETING','false');
  const message={messageId:'direct-legacy-first',fromPhone:phone,kind:'text' as const,text:'oi',groupId:null,mediaUrl:null,mimeType:null,senderName:null,replyToMessageId:null,timestampMs:Date.now()};
  await runTurn(message);const app=await getApp(),thread=liveNamespaceFor(org,phone,{kind:'user',userId:'subject-a'});
  await app.updateState({configurable:{thread_id:thread}},{messages:[{role:'assistant',content:'PRIVATE_DIRECT_ONLY'}],pendingAction:{kind:'criar_documento',args:{tipo:'venda'},askedAt:Date.now(),askedForMessageId:'direct-approval'}});
  await erase();expect(await query('SELECT 1 FROM checkpoints WHERE thread_id=$1',[thread])).toHaveLength(0);
  await runTurn({...message,messageId:'direct-legacy-reload'});const state=await app.getState({configurable:{thread_id:thread}});expect(JSON.stringify(state.values)).not.toContain('PRIVATE_DIRECT_ONLY');expect(state.values.pendingAction).toBeNull();
 });

 it('does not recreate handoff or audit when forget commits after the acceptance source SELECT',async()=>{
  await query('DELETE FROM outbox WHERE org_id=$1',[org]);
  const source=await enqueue({orgId:org,dedupeKey:'acceptance-race-source',audience:'platform_user',phone,recipientName:'Synthetic requester',title:'Synthetic',body:'Synthetic',linkUrl:null,dealId:null,orgName:'Fixture',kind:'onboarding_pending'});await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[source.id]);
  const row=await inbound('acceptance-select-forget');row.button_payload=`duvida:${source.id}`;
  let reached!:()=>void,release!:()=>void;const selected=new Promise<void>(r=>reached=r),hold=new Promise<void>(r=>release=r);const original=database.query;
  vi.spyOn(database,'query').mockImplementation(async(sql:string,args?:unknown[])=>{const result=await original(sql,args);if(sql.includes('SELECT org_id, org_name, recipient_name FROM outbox')){expect(result).toHaveLength(1);reached();await hold;}return result;});
  const work=runQueued(row as never);await selected;await erase();release();expect(await work).toBe('done');
  expect(await query('SELECT 1 FROM pending_handoff WHERE phone=$1',[phone])).toHaveLength(0);expect(await query('SELECT 1 FROM conversation_turn WHERE phone=$1',[phone])).toHaveLength(0);expect(sendText).not.toHaveBeenCalled();
 });
 it('does not recreate an early acceptance audit when its afterReply runs after a valid send and forget',async()=>{
  await query('DELETE FROM outbox WHERE org_id=$1',[org]);
  const source=await enqueue({orgId:org,dedupeKey:'acceptance-audit-source',audience:'platform_user',phone,recipientName:'Synthetic requester',title:'Synthetic',body:'Synthetic',linkUrl:null,dealId:null,orgName:'Fixture',kind:'onboarding_pending'});await query("UPDATE outbox SET status='sent',sent_at=now() WHERE id=$1",[source.id]);
  const row=await inbound('acceptance-afterreply-forget');row.button_payload=`duvida:${source.id}`;
  let reached!:()=>void,release!:()=>void;const callback=new Promise<void>(r=>reached=r),hold=new Promise<void>(r=>release=r);scheduled.afterReplyPause=async()=>{reached();await hold;};
  const work=runQueued(row as never);await callback;expect(sendText).toHaveBeenCalledTimes(1);await erase();release();expect(await work).toBe('done');
  expect(await query('SELECT 1 FROM pending_handoff WHERE phone=$1',[phone])).toHaveLength(0);expect(await query('SELECT 1 FROM conversation_turn WHERE phone=$1',[phone])).toHaveLength(0);
 });

 it('does not enqueue erased source data to a different team phone after the final preamble SELECT',async()=>{
  vi.stubEnv('MAX_ESCALATION_PHONE','5511999990710');await query('DELETE FROM outbox WHERE org_id=$1',[org]);
  await query("INSERT INTO pending_handoff(phone,org_id,org_name,requester_name,expires_at) VALUES($1,$2,'Fixture','Synthetic',now()+interval '1 hour') ON CONFLICT(phone) DO UPDATE SET consumed_by=NULL,expires_at=excluded.expires_at",[phone,org]);
  const row=await inbound('acceptance-cross-phone-forget');let reached!:()=>void,release!:()=>void;const selected=new Promise<void>(r=>reached=r),hold=new Promise<void>(r=>release=r);const original=database.query;
  vi.spyOn(database,'query').mockImplementation(async(sql:string,args?:unknown[])=>{const result=await original(sql,args);if(sql.includes("kind = 'support_handoff' AND params->>'de' = $1")){reached();await hold;}return result;});
  const work=runQueued(row as never);await selected;await erase();release();expect(await work).toBe('done');expect(await query("SELECT 1 FROM outbox WHERE params->>'de'=$1",[phone])).toHaveLength(0);expect(await query('SELECT 1 FROM conversation_turn WHERE phone=$1',[phone])).toHaveLength(0);
 });

});
