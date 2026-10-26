import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/cm", async orig => ({...await orig<typeof import("@/lib/cm")>(), fetchProfile: vi.fn(), searchKnowledge: vi.fn().mockResolvedValue([]), reportUsage: vi.fn(), chaveDePolitica: vi.fn().mockResolvedValue("corretor")}));
vi.mock("@/lib/scope", async orig => ({...await orig<typeof import("@/lib/scope")>(), consultarEscopo: vi.fn()}));
vi.mock("@/lib/llm", () => ({complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano"}));
// Exercise the tool loop rather than the separate deterministic proposal flow.
vi.mock("../consulta", async orig => ({...await orig<typeof import("../consulta")>(), pedeConsulta: vi.fn().mockReturnValue(false)}));
const {buildGraph, RESET_DO_TURN} = await import("../graph");
const {MemorySaver} = await import("@langchain/langgraph");
const {fetchProfile} = await import("@/lib/cm");
const {consultarEscopo} = await import("@/lib/scope");
const {complete} = await import("@/lib/llm");
const profile=vi.mocked(fetchProfile), scope=vi.mocked(consultarEscopo), llm=vi.mocked(complete);
const identity={kind:"user" as const,orgId:"qa-org",orgName:"QA",userId:"broker",userName:"Corretor"};
const usage={model:"test",promptTokens:5,completionTokens:5,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0.001,generationId:null,latencyMs:1,success:true};
function turn(text:string) {return {...RESET_DO_TURN,identity,inbound:{fromPhone:"+5511999063228",text,messageId:crypto.randomUUID(),kind:"text",timestampMs:Date.now(),groupId:null,mediaUrl:null,mimeType:null,senderName:"QA",replyToMessageId:null}} as never;}
const invalid={items:[],truncated:false,clarification:{field:"estado" as const,options:["Formulário","Em contrato"]}};
beforeEach(()=>{vi.clearAllMocks();llm.mockReset();scope.mockReset();profile.mockReset();profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list"]}}} as never);llm.mockResolvedValue({text:"Resposta do modelo",toolCalls:[],usage});});
describe("etapa pedida com filtro omitido pelo modelo",()=>{
 it.each(["Liste meus negócios e informe a etapa de cada um", "Liste meus negócios em ordem de atualização", "Liste negócios e mostre a etapa atual", "Liste negócios e informe a fase atual", "Liste negócios em uma tabela com a etapa atual", "Liste negócios em formato de lista", "Liste negócios em detalhes", "Liste negócios em tópicos"])("preserva listagem sem filtro para projeção/formatação: %s",async text=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:""}}],usage});scope.mockResolvedValue({items:[],truncated:false});
  await buildGraph().compile().invoke(turn(text));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{estado:""}]);
 });
 it("formatação não oculta um filtro afirmativo na mesma mensagem",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[],truncated:false});
  await buildGraph().compile().invoke(turn("Liste negócios em uma tabela na etapa Formulário"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{estado:"Formulário"}]);
 });
 it.each(["Negócios pela fase Formulário", "Negócios etapa: Formulário", "Negócios fase: Formulário"])("reconhece pista afirmativa de filtro: %s",async text=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[],truncated:false});
  await buildGraph().compile().invoke(turn(text));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{estado:"Formulário"}]);
 });
 it("corrige negócios omitidos em consulta mista e preserva propostas",async()=>{
  profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list","proposal.list"]}}} as never);
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}},{name:"listar_propostas",args:{}}],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"QA"}],truncated:false}).mockResolvedValueOnce({items:[{id:"P1",titulo:"Proposta QA"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Negócios em Formulário e minhas propostas"));
  expect(scope.mock.calls.map(call=>[call[0].verb,call[0].args])).toEqual([["deal.list",{opcoes_etapas:true}],["deal.list",{estado:"Formulário"}],["proposal.list",{}]]);
  expect(state.toolResults.filter(result=>result.items?.length)).toHaveLength(2);
 });
 it.each([invalid,null])("preserva consulta irmã quando não pode aplicar a etapa omitida: %j",async lookup=>{
  profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list","proposal.list"]}}} as never);
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}},{name:"listar_propostas",args:{}}],usage})
    .mockResolvedValueOnce({text:"Proposta QA. Informe a etapa dos negócios pelo nome.",toolCalls:[],usage});
  scope.mockResolvedValueOnce(lookup).mockResolvedValueOnce({items:[{id:"P1",titulo:"Proposta QA"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Negócios na etapa Inexistente e minhas propostas"));
  expect(scope.mock.calls.map(call=>[call[0].verb,call[0].args])).toEqual([["deal.list",{opcoes_etapas:true}],["proposal.list",{}]]);
  expect(state.reply).toContain("Proposta QA");expect(state.referencias?.itens[0].id).toBe("P1");
 });
 it("não descarta resultado válido de outra chamada listar_negocios",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}},{name:"listar_negocios",args:{estado:"Formulário"}}],usage})
    .mockResolvedValueOnce({text:"Negócio QA. Para a outra consulta informe a etapa.",toolCalls:[],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"Negócio QA"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste os negócios de venda e os em Formulário"));
  expect(state.reply).toContain("Negócio QA");expect(state.referencias?.itens[0].id).toBe("D1");expect(state.queryOptions?.numbered).toBe(false);
 });
 it.each([{}, {estado:""}, {estado:"   "}])("consulta a etapa canônica antes de buscar negócios: %j",async args=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{...args,limite:10}}],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"QA",etapa:"Formulário"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste meus negócios em formulario e informe a etapa de cada um."));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{...args,limite:10,estado:"Formulário"}]);
  for(const [request] of scope.mock.calls)expect(request).toMatchObject({orgId:"qa-org",subject:{kind:"user",userId:"broker"},verb:"deal.list"});
  expect(state.toolLog.map(entry=>entry.outcome)).toEqual(["opcoes_consulta","ok"]);
  expect(state.usage).toHaveLength(2);
 });
 it.each(["Negócios na etapa Inexistente", "Negócios não em Formulário", "Negócios em Formulário ou em Em contrato"])("não consulta sem filtro nem adivinha: %s",async text=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValue(invalid);
  const state=await buildGraph().compile().invoke(turn(text));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true}]);
  expect(llm).toHaveBeenCalledTimes(1);expect(state.reply).toContain("Qual etapa");
 });
 it.each([null,{items:[],truncated:false}])("falha de lookup encerra sem consulta ampla ou loop: %j",async result=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:""}}],usage});scope.mockResolvedValue(result);
  const state=await buildGraph().compile().invoke(turn("Negócios na fase Formulário"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true}]);
  expect(llm).toHaveBeenCalledTimes(1);expect(state.reply).toContain("Não consegui obter");expect(state.queryOptions).toBeNull();
 });
 it("não faz lookup extra quando nenhuma etapa foi pedida",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValue({items:[],truncated:false});
  await buildGraph().compile().invoke(turn("Liste meus negócios"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{}]);
 });
 it("mantém etapa válida vazia como consulta filtrada sem menu",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:""}}],usage});
  scope.mockResolvedValueOnce({...invalid,clarification:{field:"estado",options:["Formulário","Comissão paga"]}}).mockResolvedValueOnce({items:[],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Meus negócios na etapa Comissão paga"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{estado:"Comissão paga"}]);
  expect(state.queryOptions).toBeNull();expect(state.toolLog.at(-1)?.outcome).toBe("ok");
 });
 it("revalida permissão antes do preflight e não consulta quando negada",async()=>{
  profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:[]}}} as never);
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});
  await buildGraph().compile().invoke(turn("Meus negócios em Formulário"));
  expect(scope).not.toHaveBeenCalled();expect(llm).toHaveBeenCalledTimes(1);
 });
 it("não repete o preflight nem a correção quando a etapa muda",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValue(invalid);
  const state=await buildGraph().compile().invoke(turn("Meus negócios em Formulário"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{estado:"Formulário"}]);
  expect(llm).toHaveBeenCalledTimes(1);expect(state.reply).toContain("Qual etapa");
 });
 it("bloqueia nova omissão do modelo após uma consulta filtrada sem repetir lookup",async()=>{
  llm.mockResolvedValue({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"QA",etapa:"Formulário"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Meus negócios em Formulário"));
  expect(scope.mock.calls.map(call=>call[0].args)).toEqual([{opcoes_etapas:true},{estado:"Formulário"}]);
  expect(llm).toHaveBeenCalledTimes(3);expect(state.toolLog.map(entry=>entry.outcome)).toEqual(["opcoes_consulta","ok","aguardando_etapa","aguardando_etapa"]);
  expect(state.reply).toContain("informe a etapa");expect(state.usage).toHaveLength(3);
 });
});
describe("etapas reais nas consultas",()=>{
 it("corrige venda para a etapa explicitamente pedida, uma única vez, preservando sujeito e custo",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda",limite:10}}],usage});
  scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"Negócio QA",etapa:"Formulário"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste meus negócios de venda em Formulário e informe a etapa de cada um."));
  expect(scope).toHaveBeenCalledTimes(2);
  expect(scope.mock.calls[1][0]).toMatchObject({orgId:"qa-org",subject:{kind:"user",userId:"broker"},args:{estado:"Formulário",limite:10}});
  expect(state.toolLog.map(x=>x.outcome)).toEqual(["filtro_invalido","ok"]);
  expect(state.usage).toHaveLength(2);
 });
});

const key=JSON.stringify([identity.orgId,{kind:"user",userId:identity.userId}]);
function pending(options=["Formulário","Em contrato"]) {return {subjectKey:key,createdAt:Date.now(),options,offset:0};}
it("devolve opções sem segunda chamada de modelo e aceita número com nova checagem da API",async()=>{
 const app=buildGraph().compile({checkpointer:new MemorySaver()}),config={configurable:{thread_id:"choices"}};
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}}],usage});
 scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D1",titulo:"QA",etapa:"Formulário"}],truncated:false});
 const first=await app.invoke(turn("Liste minhas vendas"),config);
 expect(first.reply).toContain("1) Formulário");expect(first.reply).not.toMatch(/nenhum|locação/);expect(llm).toHaveBeenCalledTimes(1);
 expect(first.queryOptions?.subjectKey).toBe(key);
 const second=await app.invoke(turn("opção 1"),config);
 expect(scope.mock.calls[1][0]).toMatchObject({subject:{kind:"user",userId:"broker"},args:{estado:"Formulário"}});
 expect(second.queryOptions).toBeNull();expect(llm).toHaveBeenCalledTimes(1);
});
it("não repete automaticamente mais de uma consulta se opções mudarem",async()=>{
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}}],usage});scope.mockResolvedValue(invalid);
 const s=await buildGraph().compile().invoke(turn("Minhas vendas em Formulário"));
 expect(scope).toHaveBeenCalledTimes(2);expect(llm).toHaveBeenCalledTimes(1);expect(s.reply).toContain("1) Formulário");
});
it.each(["Minhas vendas", "Negócios não em Formulário", "Negócios em Formulário ou em Em contrato"])("não inventa correção para %s",async text=>{
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}}],usage});scope.mockResolvedValue(invalid);
 const s=await buildGraph().compile().invoke(turn(text));expect(scope).toHaveBeenCalledTimes(1);expect(s.reply).toContain("Qual etapa");
});
it("revalida perda de capability e não mostra opções nem consulta",async()=>{
 profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:[]}}} as never);
 const s=await buildGraph().compile().invoke({...turn("1") as object,queryOptions:pending()});
 expect(scope).not.toHaveBeenCalled();expect(llm).not.toHaveBeenCalled();expect(s.queryOptions).toBeNull();expect(s.reply).toContain("permissão");
});
it.each(["expired","other-subject"])("recusa lista %s",async reason=>{
 const value=pending();if(reason==="expired")value.createdAt-=31*60*1000;else value.subjectKey="other";
 const s=await buildGraph().compile().invoke({...turn("1") as object,queryOptions:value});
 expect(scope).not.toHaveBeenCalled();expect(llm).not.toHaveBeenCalled();expect(s.queryOptions).toBeNull();expect(s.reply).toContain("expirou");
});
it("zero remove filtro só por escolha explícita e ainda usa o dispatcher",async()=>{
 scope.mockResolvedValue({items:[],truncated:false});await buildGraph().compile().invoke({...turn("0") as object,queryOptions:pending()});
 expect(scope).toHaveBeenCalledTimes(1);expect(scope.mock.calls[0][0].args).toEqual({});
});
it("MAIS pagina opções e não entrega resto antigo da resposta",async()=>{
 scope.mockResolvedValue({...invalid,clarification:{field:"estado",options:["A","B","C","D"]}});
 const s=await buildGraph().compile().invoke({...turn("mais") as object,queryOptions:pending(["A","B","C","D"]),restoDaResposta:{texto:"resto antigo",criadoEm:Date.now()}});
 expect(s.reply).toContain("4) D");expect(s.reply).not.toContain("resto antigo");expect(scope).toHaveBeenCalledTimes(1);expect(scope.mock.calls[0][0].args).toEqual({opcoes_etapas:true});expect(llm).not.toHaveBeenCalled();
});
it("número fora da página só reapresenta opções; nova pergunta libera o fluxo",async()=>{
 const app=buildGraph().compile({checkpointer:new MemorySaver()}),config={configurable:{thread_id:"new-topic"}};
 scope.mockResolvedValue(invalid);
 const s=await app.invoke({...turn("9") as object,queryOptions:pending()},config);
 expect(s.reply).toContain("Qual etapa");expect(scope).toHaveBeenCalledTimes(1);
 const next=await app.invoke(turn("O que é um contrato?"),config);expect(next.queryOptions).toBeNull();expect(llm).toHaveBeenCalledTimes(1);
});
it("opções indisponíveis não viram carteira vazia",async()=>{
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}}],usage});scope.mockResolvedValue({...invalid,clarification:{field:"estado",options:[]}});
 const s=await buildGraph().compile().invoke(turn("Minhas vendas"));expect(s.reply).toContain("Não consegui obter");expect(s.queryOptions).toBeNull();expect(llm).toHaveBeenCalledTimes(1);
});

it("nova página revalida escopo e não revela etapas antes autorizadas",async()=>{
 scope.mockResolvedValue({...invalid,clarification:{field:"estado",options:["Atual"]}});
 const s=await buildGraph().compile().invoke({...turn("mais") as object,queryOptions:pending(["Antiga A","Antiga B","Antiga C","Segredo antigo"])});
 expect(s.reply).toContain("Atual");expect(s.reply).not.toContain("Antiga");expect(s.reply).not.toContain("Segredo");
 expect(scope.mock.calls[0][0]).toMatchObject({subject:{kind:"user",userId:"broker"},args:{opcoes_etapas:true}});
});
it("falha ao atualizar opções não reapresenta cache",async()=>{
 scope.mockResolvedValue(null);const s=await buildGraph().compile().invoke({...turn("mais") as object,queryOptions:pending(["Antiga"])});
 expect(s.reply).not.toContain("Antiga");expect(s.queryOptions).toBeNull();expect(s.reply).toContain("Não consegui atualizar");
});
it("filtro inválido não descarta consultas irmãs e seus números",async()=>{
 profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list","deal.pending"]}}} as never);
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}},{name:"pendencias_do_negocio",args:{}}],usage})
  .mockResolvedValueOnce({text:"1) Pendência QA. Para negócios, informe a etapa pelo nome.",toolCalls:[],usage});
 scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D2",titulo:"Pendência QA"}],truncated:false});
 const app=buildGraph().compile({checkpointer:new MemorySaver()}),config={configurable:{thread_id:"mixed"}};
 const s=await app.invoke(turn("Liste meus negócios e minhas pendências"),config);
 expect(s.reply).toContain("Pendência QA");expect(s.referencias?.itens[0].id).toBe("D2");expect(s.queryOptions?.numbered).toBe(false);
 const system=llm.mock.calls[1][0].system;expect(system).toContain("Pendência QA");expect(system).toContain("filtro de etapa inválido");
 scope.mockResolvedValueOnce({items:[{id:"D1",titulo:"QA",etapa:"Formulário"}],truncated:false});
 const next=await app.invoke(turn("Formulário"),config);expect(next.queryOptions).toBeNull();
 expect(scope.mock.calls[2][0].args).toEqual({estado:"Formulário"});
});

it("modelo não pode remover filtro ou adivinhar etapa após clarificação em consulta mista",async()=>{
 profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list","deal.pending"]}}} as never);
 llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"venda"}},{name:"pendencias_do_negocio",args:{}}],usage})
  .mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});
 scope.mockResolvedValueOnce(invalid).mockResolvedValueOnce({items:[{id:"D2",titulo:"Pendência QA"}],truncated:false});
 const s=await buildGraph().compile().invoke(turn("Liste meus negócios e pendências"));
 expect(scope).toHaveBeenCalledTimes(2);expect(scope.mock.calls.filter(c=>c[0].verb==="deal.list")).toHaveLength(1);
 expect(s.toolLog.at(-1)?.outcome).toBe("aguardando_etapa");expect(s.pendingToolCalls).toEqual([]);
 expect(s.referencias?.itens[0].id).toBe("D2");expect(s.queryOptions?.numbered).toBe(false);expect(s.usage).toHaveLength(2);
});
