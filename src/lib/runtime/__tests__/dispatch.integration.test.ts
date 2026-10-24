import {describe,it,expect,beforeEach,vi} from 'vitest';
vi.mock('@/lib/transport',()=>({sendText:vi.fn(async()=>({messageId:'never'})),connectionStatus:vi.fn(async()=>({connected:true}))}));
vi.mock('@/graph/graph',()=>({runTurn:vi.fn()}));
const {query}=await import('../../db');
const {sendText}=await import('@/lib/transport');
const {runTurn}=await import('@/graph/graph');
const {runQueued}=await import('../../inbound');
const {transitionControl}=await import('../handoff');
const d=process.env.DATABASE_URL?describe:describe.skip;
d('inbound final dispatch fencing',()=>{
 beforeEach(async()=>{vi.stubEnv('MAX_HANDOFF','true');vi.clearAllMocks();await query("DELETE FROM inbound_queue WHERE message_id='fence-fixture'");await query("DELETE FROM conversation_control WHERE org_id='dispatch-test'");});
 it('discards bot reply when ownership changes during graph execution',async()=>{
  const [row]=await query(`INSERT INTO inbound_queue(id,message_id,from_phone,kind,text,status) VALUES('fence-fixture','fence-fixture','5511999990000','text','oi','processing') RETURNING *`);
  vi.mocked(runTurn).mockImplementation(async()=>{
   await transitionControl({orgId:'dispatch-test',phone:'+5511999990000',operation:'request',actorId:'human'});
   return {reply:'outdated bot reply',afterReply:async()=>{},control:{orgId:'dispatch-test',controlVersion:0}};
  });
  expect(await runQueued(row as never)).toBe('done');
  expect(sendText).not.toHaveBeenCalled();
  const [settled]=await query("SELECT last_error FROM inbound_queue WHERE id='fence-fixture'");expect(settled.last_error).toContain('control');
 });
});
