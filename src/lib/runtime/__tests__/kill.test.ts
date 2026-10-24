import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../../meta',()=>({sendText:async()=>{throw new Error('external_called');},sendTemplate:async()=>{throw new Error('external_called');}}));
import {sendText} from '../../transport';
import {dispatchDue} from '../../outbox';
afterEach(()=>vi.unstubAllEnvs());
describe('outbound switch',()=>{
 it('stops transport and leaves outbox unclaimed',async()=>{
  vi.stubEnv('MAX_OUTBOUND_KILL','true');
  await expect(sendText({to:'+5511999990000',body:'fixture'})).rejects.toThrow('outbound_disabled');
  expect(await dispatchDue()).toMatchObject({claimed:0,sent:0,failed:0});
 });
});
