import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Atividades v2 (M1) no GRAFO: o toque no botão `atv:` e as tools de escrita. Mesmo padrão de
 * mocks do `fluxo-no-grafo.test.ts`. Nenhum desses turns chama o modelo de resposta no botão.
 */

vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  fetchProfile: vi.fn(),
  searchKnowledge: vi.fn(),
  reportUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), DEFAULT_MODEL: "openai/gpt-5.4-nano" }));
vi.mock("@/lib/acao", async (orig) => ({ ...(await orig<typeof import("@/lib/acao")>()), executarAcao: vi.fn() }));
vi.mock("@/lib/scope", async (orig) => ({ ...(await orig<typeof import("@/lib/scope")>()), consultarEscopo: vi.fn() }));

const { buildGraph } = await import("../graph");
const { fetchProfile, searchKnowledge } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { executarAcao } = await import("@/lib/acao");
const { consultarEscopo } = await import("@/lib/scope");

const llm = complete as unknown as ReturnType<typeof vi.fn>;
const acao = executarAcao as unknown as ReturnType<typeof vi.fn>;
const leitura = consultarEscopo as unknown as ReturnType<typeof vi.fn>;

const usuario = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };
const COM = { byRole: { "*": ["deal.list", "activity.list", "activity.write"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const SEM = { byRole: { "*": ["deal.list", "activity.list"] }, byRecipient: {}, brokerDefault: ["deal.list"] };
const uso = { model: "openai/gpt-5.4-nano", promptTokens: 10, completionTokens: 5, latencyMs: 5, success: true };

function run(text: string, state: Record<string, unknown> = {}, messageId = "m1", buttonPayload: string | null = null, kind: "text" | "audio" | "image" | "document" = "text") {
  return buildGraph().compile().invoke({
    inbound: { messageId, fromPhone: "5511987654321", groupId: null, kind, text, mediaUrl: null,
      mimeType: null, timestampMs: null, senderName: "Olavo", replyToMessageId: null, buttonPayload },
    identity: usuario, reply: null, halt: null, propostaDescartada: false, ...state,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProfile).mockResolvedValue({ enabled: true, model: "x", instructions: null, googleMaxEnabled: true, maxPolicy: {byRole:{"*":["google.calendar.read","google.calendar.write"]}} } as never);
  vi.mocked(searchKnowledge).mockResolvedValue([]);
});

describe('Google no grafo',()=>{
 it.each(['audio', 'image', 'document', 'text'] as const)('descarta confirmação oriunda de mídia: %s', async (kind) => {
  const subjectKey=JSON.stringify(['org1',{kind:'user',userId:'u1'}]);
  const googlePending={proposalId:'p1',digest:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),kind:'calendar.cancel',preview:{},askedMessageId:'m1',subjectKey};
  acao.mockResolvedValue({status:200,body:{jobId:'j1',status:'queued'}});
  const s=await run('SIM',{googlePending,fromMedia:kind==='audio'||kind==='text'?'audio':null},'m2',null,kind);
  expect(acao).not.toHaveBeenCalled();expect(llm).not.toHaveBeenCalled();
  expect(s.googlePending).toBeNull();expect(s.reply).toContain('descartada');
 });

 it('lista Google substitui a numeração legada e impede ação no item antigo',async()=>{
  vi.mocked(fetchProfile).mockResolvedValue({enabled:true,googleMaxEnabled:true,maxPolicy:{byRole:{'*':['google.calendar.read','google.calendar.write','activity.list','activity.write']}}} as never);
  const referencias={criadoEm:Date.now(),turno:'m0',itens:[{n:1,tipo:'atividade',id:'legacy-a',rotulo:'Legada A'}]};
  llm.mockResolvedValueOnce({text:'',toolCalls:[{name:'google_atividades',args:{startAt:'2026-10-29T00:00:00Z',endAt:'2026-10-30T00:00:00Z'}}],usage:uso});
  acao.mockResolvedValueOnce({status:200,body:{items:[{id:'google-b',title:'Google B',version:1}]}});
  const s=await run('Lista minha agenda Google',{referencias},'m1');
  expect(s.reply).toContain('1. Google B');expect(s.referencias).toBeNull();
  expect(s.googleRefs?.items[0].id).toBe('google-b');
  acao.mockClear();
  llm.mockResolvedValueOnce({text:'',toolCalls:[{name:'concluir_atividade',args:{numero:1}}],usage:uso});
  const next=await run('conclui a atividade 1',{referencias:s.referencias,googleRefs:s.googleRefs},'m2');
  expect(acao).not.toHaveBeenCalled();expect(next.pendingAction).toBeNull();
 });

 it('a competing numbered stage menu invalidates the Google list',async()=>{
  vi.mocked(fetchProfile).mockResolvedValue({enabled:true,googleMaxEnabled:true,maxPolicy:{byRole:{'*':['deal.list','google.calendar.read']}}} as never);
  const subjectKey=JSON.stringify(['org1',{kind:'user',userId:'u1'}]);
  leitura.mockResolvedValueOnce({items:[],truncated:false,clarification:{field:'estado',options:['Novo']}});
  const s=await run('etapas',{queryOptions:{subjectKey,createdAt:Date.now(),options:['Novo'],offset:0},googleRefs:{subjectKey,createdAt:Date.now(),items:[{id:'a1',title:'Visita',version:2}]}});
  expect(s.reply).toContain('1) Novo');expect(s.googleRefs).toBeNull();
 });

 it('Google read grant does not require legacy activity.list',async()=>{
  vi.stubEnv('MAX_EXTENDED_QUERIES','true');vi.stubEnv('MAX_ROLLOUT_ORGS',JSON.stringify({org1:['queries']}));
  llm.mockResolvedValue({text:'',toolCalls:[{name:'google_atividades',args:{startAt:'2026-10-29T00:00:00Z',endAt:'2026-10-30T00:00:00Z'}}],usage:uso});
  acao.mockResolvedValueOnce({status:200,body:{items:[]}});
  await run('Quais minhas atividades Google para hoje?');
  expect(acao).toHaveBeenCalledWith(expect.objectContaining({verb:'google.activities'}));vi.unstubAllEnvs();
 });

 it('propõe pelo número, confirma no próximo turno sem modelo',async()=>{
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const subjectKey=JSON.stringify(['org1',{kind:'user',userId:'u1'}]);
  const googleRefs={subjectKey,createdAt:Date.now(),items:[{id:'a1',title:'Visita',version:2}]};
  llm.mockResolvedValue({text:'',toolCalls:[{name:'google_propor',args:{kind:'calendar.cancel',numero:1,activityId:'evil'}}],usage:uso});
  acao.mockResolvedValueOnce({status:200,body:{proposalId:'p1',digest:'a'.repeat(64),expiresAt,kind:'calendar.cancel',summary:{title:'Visita',dueAt:null},preview:{activityId:'a1',expectedVersion:2}}});
  const s=await run('cancela atividade na agenda Google 1',{googleRefs});
  expect(s.googlePending?.proposalId).toBe('p1');
  expect(acao).toHaveBeenCalledTimes(1);expect(acao.mock.calls[0][0].verb).toBe('google.propose');
  llm.mockClear();acao.mockResolvedValueOnce({status:200,body:{jobId:'j1',status:'queued'}});
  const s2=await run('SIM',{googlePending:s.googlePending},'m2');
  expect(llm).not.toHaveBeenCalled();expect(s2.googlePending).toBeNull();
  expect(acao.mock.calls[1][0]).toMatchObject({verb:'google.confirm',args:{proposalId:'p1',digest:'a'.repeat(64)},subject:{kind:'user',userId:'u1'},orgId:'org1'});
 });
 it('modelo não pode confirmar diretamente',async()=>{
  llm.mockResolvedValue({text:'',toolCalls:[{name:'google_confirm',args:{proposalId:'p1',digest:'a'.repeat(64)}}],usage:uso});
  const s=await run('confirma agenda Google');expect(acao).not.toHaveBeenCalled();expect(s.googlePending).toBeNull();
 });
});
