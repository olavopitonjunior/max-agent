import {describe,it,expect,vi,afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {marketingStep} from '../marketing';
const vector=JSON.parse(readFileSync(new URL('../../../docs/contracts/max-marketing-v1.json',import.meta.url),'utf8'));
const base={orgId:'fixture',text:'marketing imóvel fixture-property template fixture-template vídeo',messageId:'wire-message',now:Date.parse('2026-10-20T12:00:00.000Z'),canWrite:true,policy:['marketing.read','marketing.generate'],pending:null};
afterEach(()=>vi.unstubAllEnvs());
describe('public marketing wire contract',()=>{
 it('uses quota units in the approved preview without inventing provider cost',async()=>{
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['marketing']}));vi.stubEnv('MAX_MARKETING','true');const result=await marketingStep(base,async()=>({status:200,body:vector.prepare}));expect(result?.reply).toContain('1 unidade');expect(result?.reply).toContain('vídeo');expect(result?.reply).not.toContain('US$');
 });
 it.each([['succeeded','Sua peça está pronta.'],['unknown','incerto'],['running','preparada']])('renders the public job.state %s correctly',async(state,expected)=>{
  vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({fixture:['marketing']}));vi.stubEnv('MAX_MARKETING','true');const pending={briefId:'fixture-brief',confirmationDigest:'a'.repeat(64),expiresAt:base.now+10000,summary:'fixture'};
  const result=await marketingStep({...base,text:'sim',pending},async()=>({status:200,body:vector.states[state]}));expect(result?.reply).toContain(expected);
  const statusResult=await marketingStep({...base,text:'meu vídeo ficou pronto?',pending:result!.pending},async()=>({status:200,body:vector.states[state]}));expect(statusResult?.reply).toContain(expected);
 });
});
