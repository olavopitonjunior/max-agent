import { describe,it,expect,vi } from 'vitest';
import { googleStep,googleTools } from '../google-workspace';
const ctx={enabled:true,identity:{kind:'user',orgId:'o',userId:'u'},policy:['google.calendar.read','google.calendar.write','google.tasks.write'],now:1000,messageId:'m1',subjectKey:'o:u'} as const;
const proposal={proposalId:'p',digest:'a'.repeat(64),expiresAt:new Date(10000).toISOString(),kind:'calendar.cancel',summary:{title:'Visita atual',dueAt:null},preview:{activityId:'a',expectedVersion:2}};
const refs={createdAt:1000,subjectKey:'o:u',items:[{id:'a',title:'Visita',version:2}]};
describe('Google confirmation boundary',()=>{
 it('schedule canonicalizes optional defaults before comparing preview',async()=>{
  const input={activityId:'a',expectedVersion:2,startAt:'2026-10-30T12:00:00Z',endAt:'2026-10-30T13:00:00Z',timeZone:'America/Sao_Paulo',participants:[],createMeet:false};
  const action=vi.fn().mockResolvedValue({status:200,body:{...proposal,kind:'calendar.schedule',preview:input}});
  const r=await googleStep({...ctx,refs,call:{name:'google_propor',args:{kind:'calendar.schedule',numero:1,startAt:input.startAt,endAt:input.endAt}},action});
  expect(action).toHaveBeenCalledWith('google.propose',{kind:'calendar.schedule',input},'m1');expect(r.pending).not.toBeNull();
 });

 it('Tasks binds the activity update snapshot and renders current server summary',async()=>{
  const updatedAt='2026-10-29T12:00:00.000Z';
  const action=vi.fn().mockResolvedValue({status:200,body:{...proposal,kind:'tasks.sync',summary:{title:'Título atual do servidor',dueAt:'2026-10-30T12:00:00.000Z'},preview:{activityId:'a',expectedUpdatedAt:updatedAt}}});
  const r=await googleStep({...ctx,call:{name:'google_propor',args:{kind:'tasks.sync',numero:1,expectedUpdatedAt:'evil'}},refs:{...refs,items:[{...refs.items[0],updatedAt}]},action});
  expect(action).toHaveBeenCalledWith('google.propose',{kind:'tasks.sync',input:{activityId:'a',expectedUpdatedAt:updatedAt}},'m1');
  expect(r.reply).toContain('Título atual do servidor');expect(r.reply).toContain('2026-10-30T12:00:00.000Z');expect(r.reply).not.toContain('Versão: 2');expect(r.pending).not.toBeNull();
 });
 it('Tasks without authoritative activity update cannot propose',async()=>{
  const action=vi.fn();const r=await googleStep({...ctx,call:{name:'google_propor',args:{kind:'tasks.sync',numero:1}},refs,action});expect(action).not.toHaveBeenCalled();expect(r.pending).toBeNull();
 });

 it('defaults closed and rejects broker',()=>{expect(googleTools({...ctx,enabled:false})).toEqual([]);expect(googleTools({...ctx,identity:{kind:'broker',orgId:'o'}})).toEqual([])});
 it('resolves numbered references; never accepts model ids or versions',async()=>{const action=vi.fn().mockResolvedValue({status:200,body:proposal});const r=await googleStep({...ctx,call:{name:'google_propor',args:{kind:'calendar.cancel',numero:1,activityId:'evil',expectedVersion:99}},refs,action});expect(action).toHaveBeenCalledWith('google.propose',{kind:'calendar.cancel',input:{activityId:'a',expectedVersion:2}},'m1');expect(r.pending?.digest).toBe(proposal.digest);expect(action).not.toHaveBeenCalledWith('google.confirm',expect.anything(),expect.anything())});
 it('only next human SIM confirms exact digest once',async()=>{const action=vi.fn().mockResolvedValue({status:200,body:{status:'queued',jobId:'j'}});const pending={...proposal,askedMessageId:'m1',subjectKey:'o:u'};await googleStep({...ctx,messageId:'m2',text:'SIM',pending,action});expect(action).toHaveBeenCalledWith('google.confirm',{proposalId:'p',digest:proposal.digest},'m2');action.mockClear();const r=await googleStep({...ctx,messageId:'m2',text:'sim, muda para amanhã',pending,action});expect(action).not.toHaveBeenCalled();expect(r.pending).toBeNull()});
 it('expiry, tenant change and same turn cannot confirm',async()=>{for(const changes of [{now:10000},{subjectKey:'other'},{messageId:'m1'}]){const action=vi.fn();await googleStep({...ctx,messageId:'m2',text:'SIM',pending:{...proposal,askedMessageId:'m1',subjectKey:'o:u'},action,...changes});expect(action).not.toHaveBeenCalled()}});
 it('replay explains queued without retry',async()=>{const action=vi.fn().mockResolvedValue({status:409,body:{error:'PROPOSAL_ALREADY_CONSUMED'}});const r=await googleStep({...ctx,messageId:'m2',text:'SIM',pending:{...proposal,askedMessageId:'m1',subjectKey:'o:u'},action});expect(r.reply).toContain('já');expect(action).toHaveBeenCalledTimes(1);expect(r.pending).toBeNull()});
});
