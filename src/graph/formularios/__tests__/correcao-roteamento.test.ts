import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";

/**
 * PR-E (T17): o roteamento do pedido de correção de texto (R30), determinístico e sem modelo.
 * Negado primeiro: sem a feature ou sem a capability o roteamento é exatamente o de antes.
 * Só dado sintético.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

vi.mock("@langchain/langgraph-checkpoint-postgres", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  return { PostgresSaver: class extends MemorySaver { async setup() {} } };
});
vi.mock("@/lib/db", async (orig) => ({
  ...(await orig<typeof import("@/lib/db")>()),
  checkpointerPool: vi.fn(),
}));
vi.mock("@/lib/cm", async (orig) => ({
  ...(await orig<typeof import("@/lib/cm")>()),
  fetchProfile: vi.fn(),
  chaveDePolitica: vi.fn().mockResolvedValue("admin"),
  searchKnowledge: vi.fn().mockResolvedValue([]),
  reportUsage: vi.fn().mockResolvedValue(undefined),
  transcribeMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/acao", async (orig) => ({
  ...(await orig<typeof import("@/lib/acao")>()),
  executarAcao: vi.fn(),
}));
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  downloadMedia: vi.fn().mockResolvedValue(null),
  sendReaction: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/outbox")>()),
  enqueue: vi.fn().mockResolvedValue({ status: "queued", id: "o1", deliverAfter: new Date() }),
  cancelarPendentesPorPrefixo: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn(),
}));
vi.mock("@/lib/memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/memory")>()),
  loadFacts: vi.fn().mockResolvedValue([]),
  saveFacts: vi.fn().mockResolvedValue(0),
  extractFacts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/identity")>()),
  resolveIdentity: vi.fn(),
  saveChoice: vi.fn().mockResolvedValue(undefined),
  markGreeted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/aceite", () => ({ interceptar: vi.fn().mockResolvedValue(null), repassarDesconhecido: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/turnlog", async (orig) => ({
  ...(await orig<typeof import("@/lib/turnlog")>()),
  registrarTurn: vi.fn().mockResolvedValue(undefined),
}));

const { runTurn, getApp } = await import("../../graph");
const { pedeCorrecaoDeTexto, TEXTO_FLUXO_ABERTO } = await import("../correcao-roteamento");
const { novoFluxoV2 } = await import("../estado");
const { cancelarPendentesPorPrefixo } = await import("@/lib/outbox");
const { resolveIdentity } = await import("@/lib/identity");
const { executarAcao } = await import("@/lib/acao");
const { fetchProfile } = await import("@/lib/cm");
const { MARCADOR_DOCUMENTO_LIDO } = await import("../midia");
const { complete } = await import("@/lib/llm");
const { registrarTurn } = await import("@/lib/turnlog");

const acao = vi.mocked(executarAcao);
const perfil = vi.mocked(fetchProfile);
const llm = vi.mocked(complete);

const ORG = "org-correcao-rota";
const CANDIDATO = { orgId: ORG, orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
const ANTES = "ANTES-MARCADOR multa de 20 por cento";
const DEPOIS = "DEPOIS-MARCADOR multa de 10 por cento";
const CODIGO = "PROP-2026-0001";
let seq = 0;

function msg(text: string) {
  return {
    messageId: `wamid.RT${++seq}`, fromPhone: "5511987654321", groupId: null, kind: "text", text,
    mediaUrl: null, mimeType: null, timestampMs: null, senderName: "Marcia", replyToMessageId: null,
  } as Parameters<typeof runTurn>[0];
}

const politica = (...caps: string[]) => ({
  enabled: true, model: "x", instructions: null,
  maxPolicy: { byRole: { "*": caps }, byRecipient: {}, brokerDefault: [] },
}) as never;

function ligar(feature: boolean) {
  vi.stubEnv("MAX_FORMULARIOS_V2", feature ? "true" : "false");
  vi.stubEnv("MAX_ROLLOUT_ORGS", feature ? JSON.stringify({ [ORG]: ["formularios_v2"] }) : "{}");
  vi.stubEnv("MAX_CAPTACAO", "true");
}

const SUGESTAO = { estado: "sugestao", sugestaoId: "sug-1", paragrafoId: "p4", hashParagrafo: "h".repeat(16), antes: ANTES, depois: DEPOIS };

/** O servidor sintético: uma proposta achada por código, e a sugestão de texto. */
function servidor(extra: Record<string, unknown> = {}) {
  acao.mockImplementation((async ({ verb }: { verb: string }) => {
    if (verb === "proposal.status") return { status: 200, body: { proposta: { id: "prop-1", codigo: CODIGO, titulo: "Apto 12", status: "rascunho", signatarios: [] } } };
    if (verb === "proposal.text.suggest" || verb === "captacao.text.suggest") return { status: 200, body: { ...SUGESTAO, ...extra } };
    return { status: 200, body: { items: [], total: 0 } };
  }) as never);
}

async function turno(texto: string, fluxo?: unknown) {
  const thread = `correcao-rota-${Math.random()}`;
  const app = await getApp();
  if (fluxo) await app.updateState({ configurable: { thread_id: thread } }, { fluxo: fluxo as never });
  const r = await withExecution(
    {
      orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
      taskId: "00000000-0000-4000-8000-0000000000d1", mode: "live", workflowVersion: "max-v1",
      controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
    },
    () => runTurn(msg(texto))
  );
  await r.afterReply();
  const values = (await app.getState({ configurable: { thread_id: thread } })).values as Record<string, unknown>;
  return { r, values };
}

const verbos = () => acao.mock.calls.map(([p]) => String(p.verb));
const CAPS = ["proposal.list", "proposal.create", "proposal.update", "document.text.edit"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const resolved: Identity = { kind: "resolved", candidate: CANDIDATO, org: { orgId: ORG, orgName: "RE/MAX Trio", apiToken: "t" } };
  vi.mocked(resolveIdentity).mockResolvedValue(resolved);
  perfil.mockResolvedValue(politica(...CAPS));
  llm.mockResolvedValue({ text: "ok", toolCalls: [], usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true } } as never);
  servidor();
});

describe("pedeCorrecaoDeTexto: o detector lexical", () => {
  it.each([
    ["muda a cláusula de multa da proposta para 10%", "proposta"],
    ["Max, troca o parágrafo da rescisão na proposta PROP-2026-0001", "proposta"],
    ["corrige a redação da cláusula 5 da proposta", "proposta"],
    ["reescreve o trecho do prazo da captação", "captacao"],
    ["altera a cláusula de multa", "indefinido"],
    ["pode mudar a cláusula da multa na proposta?", "proposta"],
    ["corrige o contrato", "contrato"],
    ["muda a cláusula de multa do contrato", "contrato"],
    ["reescreve o texto da proposta", "proposta"],
  ])("'%s' é correção de texto (%s)", (texto, alvo) => {
    expect(pedeCorrecaoDeTexto(texto)).toBe(alvo);
  });

  // R32: palavra de DADO nunca é marca de texto ("item", "itens", "texto" sozinho).
  it.each([
    "inclui o item churrasqueira",
    "adiciona item: vaga de garagem",
    "tira os itens da lista",
    "atualiza o texto do anúncio",
    "corrige o texto",
  ])("R32: '%s' NÃO é correção de texto (nem com a regra branda)", (texto) => {
    expect(pedeCorrecaoDeTexto(texto)).toBeNull();
    expect(pedeCorrecaoDeTexto(texto, { forte: true })).toBeNull();
  });

  it("com fluxo aberto (forte) só cláusula, parágrafo, redação ou 'texto do documento' contam; 'trecho' não", () => {
    expect(pedeCorrecaoDeTexto("reescreve o trecho do prazo da proposta")).toBe("proposta");
    expect(pedeCorrecaoDeTexto("reescreve o trecho do prazo da proposta", { forte: true })).toBeNull();
    expect(pedeCorrecaoDeTexto("muda a cláusula de multa da proposta", { forte: true })).toBe("proposta");
    expect(pedeCorrecaoDeTexto("corrige o parágrafo da rescisão", { forte: true })).toBe("indefinido");
    expect(pedeCorrecaoDeTexto("ajusta a redação da proposta", { forte: true })).toBe("proposta");
    expect(pedeCorrecaoDeTexto("muda o texto do documento", { forte: true })).toBe("indefinido");
  });

  it.each([
    "corrige o CPF da proposta",
    "muda o valor da proposta do João para 480 mil",
    "troca o e-mail do comprador na proposta PROP-2026-0001",
    "atualiza o telefone da captação",
    "não muda a cláusula de multa da proposta",
    "como mudo a cláusula da proposta?",
    "qual a cláusula de multa da proposta?",
    "o texto da proposta está certo?",
    "quero criar uma proposta",
    "oi",
    "",
  ])("'%s' NÃO é correção de texto", (texto) => {
    expect(pedeCorrecaoDeTexto(texto)).toBeNull();
  });
});

describe("T17: negado primeiro (sem feature ou capability, o roteamento é o de antes)", () => {
  const PEDIDO = `muda a cláusula de multa da proposta ${CODIGO} para 10%`;

  it("feature desligada: nunca chama text.suggest; o pedido segue para a gestão (editar), como hoje", async () => {
    ligar(false);
    await turno(PEDIDO);
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(verbos()).toContain("proposal.status");
  });

  it("sem a capability document.text.edit: nunca chama text.suggest; o pedido segue para a gestão", async () => {
    ligar(true);
    perfil.mockResolvedValue(politica("proposal.list", "proposal.create", "proposal.update"));
    await turno(PEDIDO);
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(verbos()).toContain("proposal.status");
  });

  it("sem capability, 'corrige o contrato' segue a recusa de hoje (nada do roteamento novo)", async () => {
    ligar(true);
    perfil.mockResolvedValue(politica("proposal.list"));
    const { r } = await turno("corrige o contrato");
    expect(r.reply).toMatch(/Contrato eu não gero, não edito/);
  });

  it("feature desligada, 'corrige o contrato' segue a recusa de hoje", async () => {
    ligar(false);
    const { r } = await turno("corrige o contrato");
    expect(r.reply).toMatch(/Contrato eu não gero, não edito/);
  });
});

describe("T17: com feature e capability", () => {
  it("proposta citada por código: abre o fluxo, sugere e mostra antes/depois (sem o modelo)", async () => {
    ligar(true);
    const { r, values } = await turno(`muda a cláusula de multa da proposta ${CODIGO} para 10%`);
    expect(verbos()).toEqual(["proposal.status", "proposal.text.suggest"]);
    const suggest = acao.mock.calls.find(([p]) => p.verb === "proposal.text.suggest")![0];
    expect(suggest.args).toMatchObject({ proposta_id: "prop-1" });
    expect(suggest.args).not.toHaveProperty("aceita_cancelar");
    expect(r.reply).toContain(ANTES);
    expect(r.reply).toContain(DEPOIS);
    expect(r.reply).toMatch(/1\. Aplicar/);
    expect(llm).not.toHaveBeenCalled();
    // Sensível: o corretor vê o texto, o checkpoint só o marcador (R29).
    expect(r.sensivel).toBe(true);
    expect(r.replyGravado).toBe(MARCADOR_DOCUMENTO_LIDO);
    const fluxo = values.fluxo as { kind: string; etapa: string; id: string };
    expect(fluxo).toMatchObject({ kind: "correcao_texto", etapa: "sugestao", id: "prop-1" });
    expect(JSON.stringify(values)).not.toContain("MARCADOR multa");
  });

  it("'corrige o CPF da proposta' é DADO: nunca vira text.suggest, segue em proposal.update (gestão)", async () => {
    ligar(true);
    const { r, values } = await turno(`corrige o CPF da proposta ${CODIGO} para 529.982.247-25`);
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(verbos()).toEqual(["proposal.options", "proposal.status"]);
    // M6: a GESTÃO abriu de fato (ajuste do rascunho), não só "nenhum .text.".
    expect(values.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "prop-1" });
    expect(r.reply).toMatch(/O que você quer mudar na proposta PROP-2026-0001/);
  });

  it("proposta sem citação e sem fluxo aberto: pergunta qual, não chama o servidor, não adivinha", async () => {
    ligar(true);
    const { r } = await turno("muda a cláusula de multa da proposta para 10%");
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/Qual proposta devo corrigir/);
  });

  it("proposta com mais de uma achada: lista os códigos e pede o código; nada é sugerido", async () => {
    ligar(true);
    acao.mockImplementation((async ({ verb }: { verb: string }) => {
      if (verb === "proposal.list") {
        return { status: 200, body: { total: 2, busca: "joao", items: [
          { id: "a", codigo: "PROP-2026-0001", titulo: "Joao Silva", status: "rascunho", signatarios: [{ nome: "Joao Silva", status: "pendente" }] },
          { id: "b", codigo: "PROP-2026-0002", titulo: "Joao Souza", status: "rascunho", signatarios: [{ nome: "Joao Souza", status: "pendente" }] },
        ] } };
      }
      return { status: 200, body: {} };
    }) as never);
    const { r } = await turno("muda a cláusula de multa da proposta do João para 10%");
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(r.reply).toContain("PROP-2026-0001");
    expect(r.reply).toContain("PROP-2026-0002");
    expect(r.reply).toMatch(/Me diga o código/);
  });

  it("proposta do fluxo aberto (ajuste de rascunho) vale como contexto quando o pedido não cita outra", async () => {
    ligar(true);
    const fluxo = { kind: "proposta", etapa: "ajustes", dados: {}, propostaId: "prop-9", codigo: "PROP-2026-0009", atualizadoEm: Date.now() };
    await turno("muda a cláusula de multa da proposta para 10%", fluxo);
    expect(verbos()).toEqual(["proposal.text.suggest"]);
    expect(acao.mock.calls[0]![0].args).toMatchObject({ proposta_id: "prop-9" });
  });

  it("R32: captação COM captacaoId em revisão: a correção NÃO substitui o fluxo; frase fixa, fluxo intacto, sem servidor nem modelo", async () => {
    ligar(true);
    const fluxo = { kind: "captacao", versao: 2, etapa: "revisao", captacaoId: "cap-7", codigo: "CAP-7", atualizadoEm: Date.now() };
    const { r, values } = await turno("muda a cláusula de multa da captação para 10%", fluxo);
    expect(acao).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(r.reply).toBe(TEXTO_FLUXO_ABERTO);
    expect(values.fluxo).toMatchObject({ kind: "captacao", etapa: "revisao", captacaoId: "cap-7" });
    // N1: a fala do corretor vai cega ao checkpoint e ao log (o corretor ainda vê a frase fixa acima).
    expect(r.sensivel).toBe(true);
  });

  it("captação SEM captacaoId no contexto: pergunta qual / manda para a tela, nunca adivinha", async () => {
    ligar(true);
    const { r } = await turno("muda a cláusula de multa da captação para 10%");
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/Qual captação devo corrigir/);
  });

  it("captação em fluxo SEM id (ainda colhendo): não usa esse fluxo como alvo", async () => {
    ligar(true);
    const fluxo = { kind: "captacao", versao: 2, etapa: "imovel", atualizadoEm: Date.now() };
    const { r } = await turno("muda a cláusula de multa da captação para 10%", fluxo);
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(r.reply).not.toContain(ANTES);
  });

  it("contrato: responde com o caminho da tela (sem recusa genérica), sem tocar no servidor", async () => {
    ligar(true);
    const { r } = await turno("corrige a cláusula de multa do contrato");
    expect(acao).not.toHaveBeenCalled();
    expect(r.reply).toMatch(/editor do documento, pela tela do negócio/);
    expect(r.reply).not.toMatch(/Contrato eu não gero/);
    expect(r.sensivel).toBe(true); // N1: o turno roteado pela correção é cego no checkpoint e no log
  });

  it("'corrige o contrato' (sem palavra de texto) também responde com o caminho da tela", async () => {
    ligar(true);
    const { r } = await turno("corrige o contrato");
    expect(r.reply).toMatch(/pela tela do negócio/);
    expect(r.reply).not.toMatch(/Contrato eu não gero/);
  });

  it("recurso desligado no servidor (403 fluxo_desligado): o turno segue como se a detecção não tivesse disparado", async () => {
    ligar(true);
    acao.mockImplementation((async ({ verb }: { verb: string }) => {
      if (verb === "proposal.status") return { status: 200, body: { proposta: { id: "prop-1", codigo: CODIGO, titulo: "Apto 12", status: "rascunho", signatarios: [] } } };
      if (verb === "proposal.text.suggest") return { status: 403, body: { error: "fluxo_desligado" } };
      return { status: 200, body: { items: [], total: 0 } };
    }) as never);
    const { r, values } = await turno(`muda a cláusula de multa da proposta ${CODIGO} para 10%`);
    expect(verbos()).toContain("proposal.text.suggest");
    expect((values.fluxo as { kind?: string } | undefined)?.kind).not.toBe("correcao_texto");
    // M6: o turno SEGUIU para a gestão (que responde que cláusula não se ajusta por ali), não ficou mudo nem foi para a correção.
    expect(verbos().slice(-2)).toEqual(["proposal.options", "proposal.status"]);
    expect(values.fluxo).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "prop-1" });
    expect(r.reply).toMatch(/Cláusula não dá para ajustar pelo WhatsApp/);
  });

  it("política indisponível: o roteamento novo nem dispara (cai no caminho de hoje)", async () => {
    ligar(true);
    perfil.mockRejectedValue(new Error("fora do ar"));
    await turno(`muda a cláusula de multa da proposta ${CODIGO} para 10%`);
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
  });
});

describe("R32: a correção nunca substitui um fluxo aberto", () => {
  const agora = () => Date.now();
  const v2 = () => ({ ...novoFluxoV2({ esteira: "venda", agora: agora(), schemaType: "compra_venda_v1" }), fichaAgendadaEm: agora() - 1000 });
  const captacao = (etapa: string) => ({ kind: "captacao", versao: 2, etapa, captacaoId: "cap-7", codigo: "CAP-7", atualizadoEm: agora() });

  it("'inclui o item churrasqueira' durante a coleta da proposta v2 segue na coleta: nada de .text., fluxo e ficha agendada intactos", async () => {
    ligar(true);
    const fluxo = v2();
    const { values } = await turno("inclui o item churrasqueira", fluxo);
    // O turno é da coleta (o condutor v2 trata o dado), não da correção: nunca .text., o fluxo segue v2.
    expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    expect(values.fluxo).toMatchObject({ kind: "proposta_v2", esteira: "venda" });
  });

  it.each(["proprietarios", "extras", "revisao"])(
    "'inclui o item churrasqueira' em captação (etapa %s) segue na captação: nada de .text.",
    async (etapa) => {
      ligar(true);
      perfil.mockResolvedValue(politica(...CAPS, "captacao.create", "captacao.send"));
      const { r, values } = await turno("inclui o item churrasqueira", captacao(etapa));
      expect(verbos().some((v) => v.includes(".text."))).toBe(false);
      expect(r.reply).not.toContain(ANTES);
      expect(values.fluxo).toMatchObject({ kind: "captacao", etapa, captacaoId: "cap-7" });
    }
  );

  it("palavra forte durante a coleta v2: frase fixa, o fluxo v2 e o job da ficha ficam como estavam (sem cancelar a ficha)", async () => {
    ligar(true);
    const fluxo = v2();
    const { r, values } = await turno("muda a cláusula de multa da proposta para 10%", fluxo);
    expect(r.reply).toBe(TEXTO_FLUXO_ABERTO);
    expect(acao).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(cancelarPendentesPorPrefixo).not.toHaveBeenCalled();
    expect(values.fluxo).toMatchObject({ kind: "proposta_v2", etapa: fluxo.etapa, fichaAgendadaEm: fluxo.fichaAgendadaEm });
  });

  it.each(["proprietarios", "extras", "revisao"])("palavra forte em captação (etapa %s): frase fixa e a captação intacta", async (etapa) => {
    ligar(true);
    const { r, values } = await turno("corrige o parágrafo da rescisão", captacao(etapa));
    expect(r.reply).toBe(TEXTO_FLUXO_ABERTO);
    expect(acao).not.toHaveBeenCalled();
    expect(values.fluxo).toMatchObject({ kind: "captacao", etapa, captacaoId: "cap-7" });
  });

  it("M5: 'corrige o contrato' com a captação em revisão só orienta e deixa a captação intacta (não rebaixa)", async () => {
    ligar(true);
    const fluxo = captacao("revisao");
    const { r, values } = await turno("corrige o contrato", fluxo);
    expect(r.reply).toMatch(/pela tela do negócio/);
    expect(acao).not.toHaveBeenCalled();
    expect(values.fluxo).toMatchObject({ kind: "captacao", etapa: "revisao", captacaoId: "cap-7", atualizadoEm: fluxo.atualizadoEm });
  });

  it("M5: 'corrige o contrato' com a proposta v2 aberta só orienta e deixa o fluxo intacto", async () => {
    ligar(true);
    const fluxo = v2();
    const { values } = await turno("corrige o contrato", fluxo);
    expect(values.fluxo).toMatchObject({ kind: "proposta_v2", fichaAgendadaEm: fluxo.fichaAgendadaEm });
  });

  it("flag OFF: o desvio da frase fixa não existe (nada de TEXTO_FLUXO_ABERTO, nada de .text.)", async () => {
    ligar(false);
    perfil.mockResolvedValue(politica(...CAPS, "captacao.create", "captacao.send"));
    for (const fluxo of [captacao("revisao"), v2()]) {
      const { r } = await turno("muda a cláusula de multa da proposta para 10%", fluxo);
      expect(r.reply).not.toBe(TEXTO_FLUXO_ABERTO);
      expect(verbos().some((v) => v.includes(".text."))).toBe(false);
    }
  });
});

describe("N1: a fala do corretor nas respostas fixas não vai em claro ao checkpoint nem ao log", () => {
  const CPF = "52998224725";
  const CPF_FORMATADO = "529.982.247-25";
  const agora = () => Date.now();
  const captacao = () => ({ kind: "captacao", versao: 2, etapa: "proprietarios", captacaoId: "cap-7", codigo: "CAP-7", atualizadoEm: agora() });
  const v2 = () => novoFluxoV2({ esteira: "venda", agora: agora(), schemaType: "compra_venda_v1" });

  const semEmClaro = (values: Record<string, unknown>, extra: string[] = []) => {
    const estado = JSON.stringify(values);
    const log = JSON.stringify(vi.mocked(registrarTurn).mock.calls.at(-1)![0]);
    for (const s of [CPF, CPF_FORMATADO, ...extra]) {
      expect(estado).not.toContain(s);
      expect(log).not.toContain(s);
    }
  };

  it.each([["captação", captacao], ["proposta v2", v2]] as const)(
    "palavra forte com %s aberta: a frase fixa chega ao corretor e o CPF fica fora do checkpoint e do log", async (_nome, abrir) => {
      ligar(true);
      perfil.mockResolvedValue(politica(...CAPS, "captacao.create", "captacao.send"));
      const { r, values } = await turno(`muda a cláusula de multa: o proprietário tem CPF ${CPF} e ${CPF_FORMATADO}`, abrir());
      expect(r.reply).toBe(TEXTO_FLUXO_ABERTO);
      expect(acao).not.toHaveBeenCalled();
      expect(llm).not.toHaveBeenCalled();
      semEmClaro(values);
    }
  );

  it("resposta só de orientação (contrato) com captação aberta: o CPF também não fica em claro", async () => {
    ligar(true);
    perfil.mockResolvedValue(politica(...CAPS, "captacao.create", "captacao.send"));
    const { r, values } = await turno(`corrige a cláusula do contrato, CPF ${CPF}`, captacao());
    expect(r.reply).toMatch(/pela tela do negócio/);
    semEmClaro(values);
    // Só orienta: a captação continua intacta.
    expect(values.fluxo).toMatchObject({ kind: "captacao", etapa: "proprietarios", captacaoId: "cap-7" });
  });

  it("o turno que ABRE a correção também não deixa o pedido (nem o CPF colado) no checkpoint nem no log", async () => {
    ligar(true);
    servidor();
    const { values } = await turno(`muda a cláusula de multa da proposta ${CODIGO} para 10% PEDIDO-ABERTURA-MARCADOR CPF ${CPF}`);
    expect(verbos()).toContain("proposal.text.suggest");
    semEmClaro(values, ["PEDIDO-ABERTURA-MARCADOR"]);
    expect(JSON.stringify(values.messages)).not.toContain(ANTES);
  });
});
