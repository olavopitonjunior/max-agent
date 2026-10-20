import {describe,it,expect,vi,afterEach} from 'vitest';
import {marketingStep} from '../marketing';
const base={text:'marketing imóvel property-1 template minimal arte',messageId:'fixture-message-id',now:Date.now(),canWrite:true,policy:['marketing.read','marketing.generate'],pending:null};
afterEach(()=>vi.unstubAllEnvs());
describe('marketing deterministic confirmation',()=>{
 it('is inert with flag off',async()=>{expect(await marketingStep(base,async()=>null)).toBeNull();});
 it('prepares official source and binds explicit subsequent confirmation to digest',async()=>{
  vi.stubEnv('MAX_MARKETING','true');const calls:string[]=[];
  const action=async(verb:string,args:Record<string,unknown>)=>{calls.push(verb);if(verb==='marketing.prepare')return {status:200,body:{briefId:'brief-1',confirmationDigest:'a'.repeat(64),expiresAt:new Date(base.now+60000).toISOString(),snapshot:{copy:'Apartamento de 2 quartos',template:'Minimal',modality:'artwork',quotaUnits:1}}};expect(args.confirmationDigest).toBe('a'.repeat(64));return {status:200,body:{job:{id:'job-1',state:'succeeded',artifacts:[]}}};};
  const prepared=await marketingStep(base,action);expect(prepared?.pending?.briefId).toBe('brief-1');expect(calls).toEqual(['marketing.prepare']);
  const generated=await marketingStep({...base,text:'sim',messageId:'confirm-message-id',pending:prepared!.pending},action);expect(generated?.pending?.jobId).toBe('job-1');expect(calls).toEqual(['marketing.prepare','marketing.generate']);expect(generated?.reply).toContain('pronta');
 });
 it('lets a broker choose visible property and named template without internal ids',async()=>{
  vi.stubEnv('MAX_MARKETING','true');const verbs:string[]=[];
  const action=async(verb:string,args:Record<string,unknown>)=>{verbs.push(verb);if(verb==='marketing.options')return {status:200,body:{templates:[{id:'template-internal',name:'Minimal'}]}};if(verb==='property.list')return {status:200,body:{items:[{id:'property-internal',tipo:'apartamento',bairro:'Centro',cidade:'São Paulo',dormitorios:2}],truncated:false}};expect(args.propertyId).toBe('property-internal');expect(args.templateId).toBe('template-internal');return {status:200,body:{briefId:'brief-2',confirmationDigest:'b'.repeat(64),expiresAt:new Date(base.now+60000).toISOString(),snapshot:{copy:'Apartamento no Centro',template:'Minimal',quotaUnits:1}}};};
  const choose=await marketingStep({...base,text:'Quero uma arte para anunciar um imóvel'},action);expect(choose?.reply).toContain('1.');expect(choose?.reply).not.toContain('property-internal');
  const preview=await marketingStep({...base,text:'1',pending:choose!.pending},action);expect(preview?.reply).toContain('Confirma');expect(verbs).toEqual(['marketing.options','property.list','marketing.prepare']);
 });
 it('expires confirmation and does not treat unrelated turn as approval',async()=>{
  vi.stubEnv('MAX_MARKETING','true');let calls=0;const action=async()=>{calls++;return null;};
  const pending={briefId:'brief',confirmationDigest:'a'.repeat(64),expiresAt:base.now-1,summary:'fixture'};
  expect((await marketingStep({...base,text:'sim',pending},action))?.pending).toBeNull();expect(calls).toBe(0);
  expect((await marketingStep({...base,text:'como está minha proposta?',pending:{...pending,expiresAt:base.now+10000}},action))?.pending).toBeNull();expect(calls).toBe(0);
 });
 it('never repeats an unknown generation as a fresh paid request',async()=>{
  vi.stubEnv('MAX_MARKETING','true');const pending={briefId:'brief',confirmationDigest:'a'.repeat(64),expiresAt:base.now+10000,summary:'fixture'};
  const r=await marketingStep({...base,text:'sim',pending},async()=>null);expect(r?.pending).toBeNull();expect(r?.reply).toContain('incerto');
 });
});
