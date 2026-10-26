import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/cm", async orig => ({...await orig<typeof import("@/lib/cm")>(), fetchProfile: vi.fn(), searchKnowledge: vi.fn().mockResolvedValue([]), reportUsage: vi.fn(), chaveDePolitica: vi.fn().mockResolvedValue("corretor")}));
vi.mock("@/lib/scope", async orig => ({...await orig<typeof import("@/lib/scope")>(), consultarEscopo: vi.fn()}));
vi.mock("@/lib/llm", () => ({complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano"}));
const {buildGraph, RESET_DO_TURN} = await import("../graph");
const {MemorySaver} = await import("@langchain/langgraph");
const {fetchProfile} = await import("@/lib/cm");
const {consultarEscopo} = await import("@/lib/scope");
const {complete} = await import("@/lib/llm");
const profile=vi.mocked(fetchProfile), scope=vi.mocked(consultarEscopo), llm=vi.mocked(complete);
const identity={kind:"user" as const,orgId:"qa-org",orgName:"QA",userId:"broker",userName:"Corretor"};
const usage={model:"test",promptTokens:5,completionTokens:5,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0.001,generationId:null,latencyMs:1,success:true};
function turn(text:string) {return {...RESET_DO_TURN,identity,inbound:{fromPhone:"+5511999063228",text,messageId:crypto.randomUUID(),kind:"text",timestampMs:Date.now(),groupId:null,mediaUrl:null,mimeType:null,senderName:"QA",replyToMessageId:null}} as never;}
function menu(){return {subjectKey:JSON.stringify([identity.orgId,{kind:"user",userId:identity.userId}]),createdAt:Date.now(),options:["A","B","C","D","E","Formulário"],offset:3};}
const row={id:"D1",titulo:"Negócio QA",etapa:"Formulário",valor:100000};
beforeEach(()=>{vi.clearAllMocks();llm.mockReset();scope.mockReset();profile.mockReset();profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:["deal.list","deal.pending"]}}} as never);llm.mockResolvedValue({text:"Resposta livre",toolCalls:[],usage});});
describe("respostas factuais de negócios",()=>{
 it("seleção6 usa etapa real e referência1 sem modelo ou valor não solicitado",async()=>{
  scope.mockResolvedValue({items:[row],truncated:false});
  const state=await buildGraph().compile().invoke({...turn("6") as object,queryOptions:menu()});
  expect(llm).not.toHaveBeenCalled();expect(scope.mock.calls[0][0].args).toEqual({estado:"Formulário"});
  expect(state.reply).toContain("1. Negócio QA");expect(state.reply).toContain("Formulário");expect(state.reply).not.toMatch(/etapa\s*6|100000|quer/i);
  expect(state.referencias?.itens).toEqual([expect.objectContaining({n:1,id:"D1"})]);
  expect(state.queryOptions).toBeNull();expect(state.selectedDealQuery).toBeNull();expect(state.usage).toEqual([]);
 });
 it("zero mantém cada etapa projetada e o limite de cinco referências",async()=>{
  scope.mockResolvedValue({items:Array.from({length:6},(_,i)=>({id:`D${i+1}`,titulo:`QA ${i+1}`,etapa:i===0?"Em contrato":"Formulário"})),truncated:false});
  const state=await buildGraph().compile().invoke({...turn("0") as object,queryOptions:menu()});
  expect(llm).not.toHaveBeenCalled();expect(scope.mock.calls[0][0].args).toEqual({});
  const text=[state.reply,state.restoDaResposta?.texto].join("\n");
  expect(text).toContain("1. QA 1 — Etapa: Em contrato");expect(text).toContain("5. QA 5");expect(text).not.toContain("QA 6");expect(text).toContain("Há mais negócios");
  expect(state.referencias?.itens).toHaveLength(5);expect(state.reply?.length).toBeLessThanOrEqual(400);
 });
 it.each([true,false])("vazio válido único é factual e limitado ao filtro (seleção=%s)",async selected=>{
  scope.mockResolvedValue({items:[],truncated:false});
  if(!selected)llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{estado:"Comissão paga"}}],usage});
  const state=await buildGraph().compile().invoke(selected?{...turn("Comissão paga") as object,queryOptions:{...menu(),options:["Comissão paga"],offset:0}}:turn("Liste negócios na etapa Comissão paga"));
  expect(llm).toHaveBeenCalledTimes(selected?0:1);expect(state.reply).toContain("Não encontrei negócios");expect(state.reply).toContain("Comissão paga");expect(state.reply).toContain("para esta consulta");
  expect(state.reply).not.toMatch(/período|quer|posso|deseja/i);expect(state.queryOptions).toBeNull();
 });
 it("falha após seleção não vira vazio nem consome modelo",async()=>{
  scope.mockResolvedValue(null);
  const state=await buildGraph().compile().invoke({...turn("6") as object,queryOptions:menu()});
  expect(llm).not.toHaveBeenCalled();expect(state.reply).toContain("Não consegui consultar");expect(state.reply).not.toContain("Não encontrei");expect(state.selectedDealQuery).toBeNull();
 });
 it("clarification após seleção continua menu e não vira vazio",async()=>{
  scope.mockResolvedValue({items:[],truncated:false,clarification:{field:"estado",options:["Etapa atual"]}});
  const state=await buildGraph().compile().invoke({...turn("6") as object,queryOptions:menu()});
  expect(llm).not.toHaveBeenCalled();expect(state.reply).toContain("Etapa atual");expect(state.reply).not.toContain("Não encontrei");expect(state.selectedDealQuery).toBeNull();
 });
 it("permissão perdida impede seleção sem consultar ou chamar modelo",async()=>{
  profile.mockResolvedValue({enabled:true,maxPolicy:{byRole:{corretor:[]}}} as never);
  const state=await buildGraph().compile().invoke({...turn("6") as object,queryOptions:menu()});
  expect(scope).not.toHaveBeenCalled();expect(llm).not.toHaveBeenCalled();expect(state.reply).toContain("permissão");
 });
 it("lista livre não vazia mantém resposta do modelo",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValue({items:[row],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste meus negócios"));
  expect(llm).toHaveBeenCalledTimes(2);expect(state.reply).toBe("Resposta livre");
 });
 it("seleção finalizada não torna o próximo turno livre determinístico",async()=>{
  const app=buildGraph().compile({checkpointer:new MemorySaver()}),config={configurable:{thread_id:"selection-finished"}};
  scope.mockResolvedValue({items:[row],truncated:false});
  await app.invoke({...turn("6") as object,queryOptions:menu()},config);
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});
  const state=await app.invoke(turn("Liste meus negócios"),config);
  expect(llm).toHaveBeenCalledTimes(2);expect(state.reply).toBe("Resposta livre");expect(state.selectedDealQuery).toBeNull();
 });
 it("vazio sem etapa não afirma que a carteira inteira está vazia",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}}],usage});scope.mockResolvedValue({items:[],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste meus negócios"));
  expect(state.reply).toBe("Não encontrei negócios para esta consulta.");expect(llm).toHaveBeenCalledTimes(1);
 });
 it("vazio em consulta mista mantém resultados irmãos e resposta do modelo",async()=>{
  llm.mockResolvedValueOnce({text:"",toolCalls:[{name:"listar_negocios",args:{}},{name:"pendencias_do_negocio",args:{}}],usage});
  scope.mockResolvedValueOnce({items:[],truncated:false}).mockResolvedValueOnce({items:[{id:"D2",titulo:"Pendência QA"}],truncated:false});
  const state=await buildGraph().compile().invoke(turn("Liste negócios e pendências"));
  expect(llm).toHaveBeenCalledTimes(2);expect(state.reply).toBe("Resposta livre");expect(state.referencias?.itens[0].id).toBe("D2");
 });
});
