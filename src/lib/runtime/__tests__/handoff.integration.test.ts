import {describe,it,expect,beforeEach} from 'vitest';
import {query} from '../../db';
import {transitionControl,withBotFence,sendHuman,getControl} from '../handoff';
const d=process.env.DATABASE_URL?describe:describe.skip;
d('handoff ownership and dispatch fencing',()=>{
 const org='handoff-test',phone='+5511999990000';
 beforeEach(async()=>{await query('DELETE FROM conversation_control WHERE org_id=$1',[org]);await query('DELETE FROM handoff_send WHERE org_id=$1',[org]);});
 it('only one concurrent claimant owns conversation and bot cannot send after takeover',async()=>{
  await transitionControl({orgId:org,phone,operation:'request',actorId:'requester'});
  const claims=await Promise.allSettled(['a','b'].map(actorId=>transitionControl({orgId:org,phone,operation:'claim',actorId,controlVersion:1})));
  expect(claims.filter(c=>c.status==='fulfilled')).toHaveLength(1);
  let delivered=false;
  expect(await withBotFence(org,phone,0,async()=>{delivered=true;return 'sent';})).toEqual({sent:false});
  expect(delivered).toBe(false);
  const owner=await getControl(org,phone);expect(owner.state).toBe('human');expect(owner.controlVersion).toBe(2);
  await expect(transitionControl({orgId:org,phone,operation:'handback',actorId:'intruder',controlVersion:2})).rejects.toThrow('control_conflict');
  const back=await transitionControl({orgId:org,phone,operation:'handback',actorId:owner.ownerId!,controlVersion:2});expect(back.state).toBe('bot');expect(back.controlVersion).toBe(3);
 });
 it('durably reserves human send and never repeats after lost acknowledgement',async()=>{
  await transitionControl({orgId:org,phone,operation:'request',actorId:'a'});
  await transitionControl({orgId:org,phone,operation:'claim',actorId:'a',controlVersion:1});
  const params={orgId:org,phone,actorId:'a',controlVersion:2,requestId:'11111111-1111-4111-8111-111111111111',text:'private fixture'};
  let calls=0;
  await expect(sendHuman(params,async()=>{calls++;throw new Error('lost_ack');})).rejects.toThrow('lost_ack');
  await expect(sendHuman(params,async()=>{calls++;return {messageId:'m'};})).rejects.toThrow('send_unknown');
  await expect(sendHuman({...params,requestId:'22222222-2222-4222-8222-222222222222'},async()=>{calls++;return {messageId:'m'};})).rejects.toThrow('send_unknown');
  expect(calls).toBe(1);
  await expect(transitionControl({orgId:org,phone,operation:'handback',actorId:'a',controlVersion:2})).rejects.toThrow('send_unknown');
  expect((await query('SELECT state FROM handoff_send WHERE org_id=$1',[org]))[0].state).toBe('unknown');
 });
});
