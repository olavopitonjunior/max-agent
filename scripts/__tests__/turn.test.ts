import {describe,it,expect,vi} from 'vitest';
import {liveNamespaceFor} from '../../src/lib/runtime/context';
const fixture=vi.hoisted(()=>({orgId:'harness-fixture',phone:'+5511999990700',userId:'harness-user',cleared:[] as string[],ran:false}));
vi.mock('../../src/graph/graph',async original=>({...await original<typeof import('../../src/graph/graph')>(),runTurn:async()=>{fixture.ran=true;return {reply:null,afterReply:async()=>{}};}}));
vi.mock('../../src/lib/identity',()=>({resolveIdentity:async()=>({kind:'resolved',candidate:{kind:'user',orgId:fixture.orgId,userId:fixture.userId}})}));
vi.mock('../../src/lib/checkpointer-reset',()=>({limparThreadDoCheckpointer:async(thread:string)=>{fixture.cleared.push(thread);}}));
vi.mock('../../src/lib/db',()=>({query:async()=>[],db:()=>({end:async()=>{}})}));
describe('turn CLI --novo',()=>{
 it('resets the same subject namespace used by live turns',async()=>{
  const previous=process.argv;process.argv=['node','turn.ts',fixture.phone,'oi','--novo'];
  try{await import('../turn');await vi.waitFor(()=>expect(fixture.ran).toBe(true));expect(fixture.cleared).toContain(liveNamespaceFor(fixture.orgId,fixture.phone,{kind:'user',userId:fixture.userId}));}
  finally{process.argv=previous;}
 });
});
