import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { MapaDeReferencias } from '../referencias';
vi.mock('@/lib/scope', async orig => ({ ...await orig<typeof import('@/lib/scope')>(), consultarEscopo: vi.fn() }));
vi.mock('@/lib/cm', async orig => ({ ...await orig<typeof import('@/lib/cm')>(), fetchProfile: vi.fn(), chaveDePolitica: vi.fn().mockResolvedValue('admin'), searchKnowledge: vi.fn().mockResolvedValue([]), reportUsage: vi.fn() }));
vi.mock('@/lib/llm', () => ({ complete: vi.fn(), DEFAULT_MODEL: 'fixture' }));
vi.mock('@/lib/acao', () => ({ executarAcao: vi.fn() }));
const { despacharLeituras } = await import('../despachante');
const { consultarEscopo } = await import('@/lib/scope');
const { fetchProfile } = await import('@/lib/cm');
const { complete } = await import('@/lib/llm');
const { buildGraph } = await import('../graph');
const scope = vi.mocked(consultarEscopo);
const identity = { orgId: 'fixture-org', orgName: 'Fixture', kind: 'user' as const, userId: 'fixture-user', userName: 'Pessoa' };
const policy = ['property.list','property.detail','contract.status','deal.list','activity.list','notification.list'] as const;
const usage = { model:'fixture',promptTokens:0,completionTokens:0,latencyMs:0,success:true };
async function dispatch(name:string,args:Record<string,unknown>,referencias:MapaDeReferencias|null=null,agora=1000) {
 return despacharLeituras({ chamadas:[{name,args}],oferecidas:[name],policy,identity,fromPhone:'5511999990001',referencias,turno:`turn-${agora}`,agora });
}
beforeEach(()=>{ vi.clearAllMocks(); vi.stubEnv('MAX_EXTENDED_QUERIES','true'); vi.mocked(fetchProfile).mockResolvedValue({enabled:true,model:'fixture',maxPolicy:{byRole:{'*':[...policy]}}} as never); vi.mocked(complete).mockResolvedValue({text:'Resposta sintética',toolCalls:[],usage} as never); });
afterEach(()=>vi.unstubAllEnvs());
describe('conversational extended reads',()=>{
 it.each(['listar_imoveis','listar_atividades','listar_notificacoes'])('%s displays every result once using only the trusted continuation',async(name)=>{
  const rows=Array.from({length:12},(_,i)=>({id:`id-${i}`,titulo:`Item ${i}`}));
  scope.mockImplementation(async p=>{const offset=p.args?.cursor==='server-5'?5:p.args?.cursor==='server-10'?10:0;const size=Number(p.args?.limite??10);const end=offset+size;return {items:rows.slice(offset,end),truncated:end<rows.length,...(end<rows.length?{nextCursor:`server-${end}`}:{})};});
  let refs:MapaDeReferencias|null=null;const displayed:unknown[]=[];
  for(let page=0;page<3;page++) { const r=await dispatch(name,page?{mais:true,cursor:'forged'}:{},refs,1000+page);refs=r.referencias;displayed.push(...r.resultados[0].items??[]);expect(r.resultados[0]).toMatchObject({hasMore:page<2});expect(JSON.stringify(r.resultados)).not.toContain('server-'); }
  expect(displayed.map(x=>(x as {titulo:string}).titulo)).toEqual(rows.map(x=>x.titulo));
  expect(scope.mock.calls.map(([p])=>p.args?.cursor)).toEqual([undefined,'server-5','server-10']);
  const exhausted=await dispatch(name,{mais:true},refs,1004);expect(exhausted.resultados[0].items).toBeNull();expect(scope).toHaveBeenCalledTimes(3);
 });
 it.each([['listar_imoveis','detalhar_imovel','property.detail','imovel_id'],['listar_negocios','situacao_contrato','contract.status','negocio_id']])('resolves %s → typed selection → %s without exposing IDs',async(list,detail,verb,idField)=>{
  scope.mockResolvedValueOnce({items:[{id:'internal-1',titulo:'Primeiro'},{id:'internal-2',titulo:'Segundo'}],truncated:false});
  const page=await dispatch(list,{});scope.mockResolvedValue({items:[{id:'internal-detail',estado:'ativo'}],truncated:false});
  const result=await dispatch(detail,{numero:2,[idField]:'forged'},page.referencias);
  expect(scope.mock.calls.at(-1)?.[0]).toMatchObject({verb,args:{[idField]:'internal-2'}});
  expect(JSON.stringify(result.resultados)).not.toContain('internal-');
  for(const refs of [{...page.referencias!,criadoEm:-2000000},{...page.referencias!,itens:page.referencias!.itens.map(x=>({...x,tipo:'atividade' as const}))}]) {
   scope.mockClear();const denied=await dispatch(detail,{numero:2,[idField]:'forged'},refs);expect(denied.resultados[0].items).toBeNull();expect(scope).not.toHaveBeenCalled();
  }
 });
 it.each(['Como está o contrato?','O contrato já foi enviado?'])('routes enabled authorized contract read through graph: %s',async(text)=>{
  scope.mockResolvedValue({items:[{id:'contract-1',estado:'enviado'}],truncated:false});
  vi.mocked(complete).mockResolvedValueOnce({text:'',toolCalls:[{name:'situacao_contrato',args:{numero:1}}],usage} as never);
  const s=await buildGraph().compile().invoke({identity,inbound:{messageId:'contract-turn',fromPhone:'5511999990001',text},referencias:{criadoEm:Date.now(),turno:'list-turn',itens:[{n:1,tipo:'negocio',id:'deal-1',rotulo:'Negócio'}]}} as never);
  expect(scope).toHaveBeenCalledWith(expect.objectContaining({verb:'contract.status',args:{negocio_id:'deal-1'}}));expect(s.reply).not.toContain('eu ainda não consulto');
 });
 it.each(['flag','policy','signers','write'])('retains refusal for %s',async(gate)=>{
  if(gate==='flag')vi.stubEnv('MAX_EXTENDED_QUERIES','false');
  if(gate==='policy')vi.mocked(fetchProfile).mockResolvedValue({enabled:true,maxPolicy:{byRole:{'*':[]}}} as never);
  const text=gate==='signers'?'Quem falta assinar o contrato?':gate==='write'?'Envia o contrato para assinatura':'Como está o contrato?';
  const s=await buildGraph().compile().invoke({identity,inbound:{messageId:'refusal',fromPhone:'5511999990001',text}} as never);
  expect(scope).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();expect(s.reply).toBeTruthy();
 });
});
it('real graph continues a bare mais and queries contract after listing visible deals',async()=>{
 const { MemorySaver }=await import('@langchain/langgraph');const { RESET_DO_TURN }=await import('../graph');
 const app=buildGraph().compile({checkpointer:new MemorySaver()});const config={configurable:{thread_id:'integration-pages'}};
 scope.mockImplementation(async p=>({items:[{id:p.args?.cursor?'second':'first',titulo:p.args?.cursor?'Segundo':'Primeiro'}],truncated:!p.args?.cursor,...(!p.args?.cursor?{nextCursor:'trusted-next'}:{})}));
 async function turn(text:string,name:string,args:Record<string,unknown>){
  vi.mocked(complete).mockResolvedValueOnce({text:'',toolCalls:[{name,args}],usage} as never).mockResolvedValueOnce({text:'Lista sintética. Quer mais?',toolCalls:[],usage} as never);
  return app.invoke({...RESET_DO_TURN,identity,inbound:{messageId:text,fromPhone:'5511999990001',text}} as never,config);
 }
 await turn('listar imóveis','listar_imoveis',{});const more=await turn('mais','listar_imoveis',{mais:true});
 expect(more.referencias?.itens[0].rotulo).toBe('Segundo');expect(scope.mock.calls.at(-1)?.[0].args?.cursor).toBe('trusted-next');
 scope.mockClear();scope.mockResolvedValue({items:[{id:'deal-selected',titulo:'Negócio selecionado'}],truncated:false});
 const list=await turn('Como está o contrato?','listar_negocios',{});expect(list.referencias?.itens[0].tipo).toBe('negocio');
 await turn('2','situacao_contrato',{numero:2}); // Out-of-list choice must fail closed.
 expect(scope).toHaveBeenCalledTimes(1);
 await turn('1','situacao_contrato',{numero:1});expect(scope.mock.calls.at(-1)?.[0]).toMatchObject({verb:'contract.status',args:{negocio_id:'deal-selected'}});
});
