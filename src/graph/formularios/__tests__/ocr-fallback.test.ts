import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@/lib/identity";
import { withExecution } from "@/lib/runtime/context";

/**
 * T9 — fallback de leitura por transcricao. Org SEM `document.read`: com
 * `MAX_OCR_TRANSCRIBE_FALLBACK` ligada, uma foto COM legenda e transcrita
 * (`kind:"image"`) e o texto entra na janela de extracao como `documento_lido`
 * (DADO cercado), nunca em mensagem, memoria ou checkpoint. O custo da
 * transcricao e do servidor (AIUsage la): o agente nao reporta em dobro.
 */

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
  transcribeMedia: vi.fn(),
  lerDocumento: vi.fn(),
}));
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  downloadMedia: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  DEFAULT_MODEL: "openai/gpt-5.4-nano",
  complete: vi.fn().mockResolvedValue({
    text: "Anotei a legenda.",
    toolCalls: [],
    usage: { model: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true },
  }),
}));
vi.mock("@/lib/memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/memory")>()),
  loadFacts: vi.fn().mockResolvedValue([]),
  saveFacts: vi.fn().mockResolvedValue(undefined),
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

const { runTurn, getApp, depsDoFluxo, registrarLidosDoTurno } = await import("../../graph");
const { lerMidia } = await import("../midia");
const { novoFluxoV2 } = await import("../estado");
const { ocrTranscribeFallbackLigado } = await import("../../captacao-flags");
const { textoSemLeituraDeMidia } = await import("../../prompt");
const { resolveIdentity } = await import("@/lib/identity");
const { downloadMedia } = await import("@/lib/transport");
const { fetchProfile, transcribeMedia, reportUsage, lerDocumento } = await import("@/lib/cm");
const { complete } = await import("@/lib/llm");
const { saveFacts, extractFacts } = await import("@/lib/memory");

import type { DepsDaMidia, MidiaRecebida } from "../midia";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 2)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(2000, 3)]);
const CPF = "529.982.247-25";
const NOME = "Maria Teste da Silva";
const TEXTO_DA_IMAGEM = `RG ${NOME} CPF ${CPF}`;

const ctx = { orgId: "org1", messageId: "wamid.FOTO1" };

function deps(over: Partial<DepsDaMidia> = {}) {
  return {
    baixar: vi.fn().mockResolvedValue({ data: JPEG, contentType: "image/jpeg" }),
    lerDocumento: vi.fn(),
    transcrever: vi.fn().mockResolvedValue(TEXTO_DA_IMAGEM),
    temDocumentRead: false,
    fallbackDeTranscricao: false,
    newtonMidiaAtiva: () => true,
    ...over,
  } as unknown as DepsDaMidia & {
    baixar: ReturnType<typeof vi.fn>;
    lerDocumento: ReturnType<typeof vi.fn>;
    transcrever: ReturnType<typeof vi.fn>;
  };
}

const foto = (extra: Partial<MidiaRecebida> = {}): MidiaRecebida => ({
  kind: "image",
  ref: "meta:123",
  mimeType: "image/jpeg",
  legenda: "segue o RG do comprador",
  ...extra,
});

describe("flag desligada (padrao): sem document.read a imagem nao e lida", () => {
  it("a flag nasce desligada", () => {
    vi.unstubAllEnvs();
    expect(ocrTranscribeFallbackLigado()).toBe(false);
    vi.stubEnv("MAX_OCR_TRANSCRIBE_FALLBACK", "off");
    expect(ocrTranscribeFallbackLigado()).toBe(false);
    vi.stubEnv("MAX_OCR_TRANSCRIBE_FALLBACK", "true");
    expect(ocrTranscribeFallbackLigado()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("flag off e sem document.read: imagem -> nao_lido, sem baixar nem transcrever", async () => {
    const d = deps();
    const r = await lerMidia(d, foto(), ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
    expect(d.baixar).not.toHaveBeenCalled();
    expect(d.transcrever).not.toHaveBeenCalled();
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("flag on mas sem a dependencia de transcrever: nao_lido (nada quebra)", async () => {
    const d = deps({ fallbackDeTranscricao: true, transcrever: undefined });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
  });
});

describe("flag ligada: transcricao de imagem como texto na janela", () => {
  it("flag on: transcribe kind image -> texto com o prefixo 'Texto na imagem:'", async () => {
    const d = deps({ fallbackDeTranscricao: true });

    const r = await lerMidia(d, foto(), ctx);

    expect(r).toEqual({ tipo: "texto", texto: `Texto na imagem: ${TEXTO_DA_IMAGEM}` });
    expect(d.transcrever).toHaveBeenCalledTimes(1);
    expect(d.transcrever.mock.calls[0]![0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    // O servidor de leitura de documento NAO e chamado: a org nao tem a capability.
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("sem legenda nao ha turno para o texto alimentar: nem transcreve (sem custo a toa)", async () => {
    const d = deps({ fallbackDeTranscricao: true });
    const r = await lerMidia(d, foto({ legenda: undefined }), ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
    expect(d.transcrever).not.toHaveBeenCalled();
  });

  it("PDF sem document.read: 'ainda nao leio PDF', mesmo com a flag ligada (o fallback e so de imagem)", async () => {
    const d = deps({ fallbackDeTranscricao: true, baixar: vi.fn().mockResolvedValue({ data: PDF, contentType: "application/pdf" }) });
    const r = await lerMidia(d, foto({ kind: "document", mimeType: "application/pdf" }), ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
    expect(d.transcrever).not.toHaveBeenCalled();
  });

  it("HEIC: a frase honesta, sem transcrever", async () => {
    const d = deps({ fallbackDeTranscricao: true, baixar: vi.fn().mockResolvedValue({ data: HEIC, contentType: "image/heic" }) });
    expect(await lerMidia(d, foto({ mimeType: "image/heic" }), ctx)).toEqual({ tipo: "nao_lido", motivo: "heic" });
    expect(d.transcrever).not.toHaveBeenCalled();
  });

  it("transcricao vazia ou que falha: nao_lido falha, nunca lanca", async () => {
    expect(await lerMidia(deps({ fallbackDeTranscricao: true, transcrever: vi.fn().mockResolvedValue(null) }), foto(), ctx)).toEqual({
      tipo: "nao_lido",
      motivo: "falha",
    });
    expect(await lerMidia(deps({ fallbackDeTranscricao: true, transcrever: vi.fn().mockRejectedValue(new Error("zapi:https://x/segredo")) }), foto(), ctx)).toEqual({
      tipo: "nao_lido",
      motivo: "falha",
    });
  });

  it("com document.read a leitura estruturada vence: o fallback nao roda", async () => {
    const d = deps({
      fallbackDeTranscricao: true,
      temDocumentRead: true,
      lerDocumento: vi.fn().mockResolvedValue({ ok: true, documentType: "rg", confianca: 0.9, campos: [], ignorados: 0 }),
    });
    const r = await lerMidia(d, foto(), ctx);
    expect(r.tipo).toBe("campos");
    expect(d.transcrever).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// A janela e o grafo
// ──────────────────────────────────────────────────────────────────────────

const ORG = "org-ocr-fallback";
const CANDIDATO = { orgId: ORG, orgName: "RE/MAX Trio", kind: "user" as const, userId: "u1", userName: "Marcia" };
let seq = 0;

function inboundFoto(over: Record<string, unknown> = {}) {
  return {
    messageId: `wamid.FB${++seq}`,
    fromPhone: "5511987654321",
    groupId: null,
    kind: "image",
    text: null,
    mediaUrl: "meta:MEDIA1",
    mimeType: "image/jpeg",
    timestampMs: null,
    senderName: "Marcia",
    replyToMessageId: null,
    ...over,
  } as Parameters<typeof runTurn>[0];
}

async function turno(inbound: Parameters<typeof runTurn>[0]) {
  const thread = `ocr-fb-${Math.random()}`;
  const app = await getApp();
  await app.updateState(
    { configurable: { thread_id: thread } },
    { fluxo: novoFluxoV2({ esteira: "venda", agora: Date.now(), schemaType: "venda_padrao" }) as never }
  );
  const r = await withExecution(
    {
      orgId: ORG, subject: { kind: "user", userId: "u1" }, conversationId: thread,
      taskId: "00000000-0000-4000-8000-000000000001", mode: "live", workflowVersion: "max-v1",
      controlVersion: 0, deadline: Date.now() + 30_000, budgetUsd: 0.25, maxConcurrency: 1,
    },
    async () => {
      const out = await runTurn(inbound);
      await out.afterReply?.();
      return out;
    }
  );
  const values = (await app.getState({ configurable: { thread_id: thread } })).values as Record<string, unknown>;
  return { ...r, values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("MAX_FORMULARIOS_V2", "true");
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
  vi.mocked(downloadMedia).mockResolvedValue({ data: JPEG, contentType: "image/jpeg" });
  vi.mocked(transcribeMedia).mockResolvedValue(TEXTO_DA_IMAGEM);
  // Politica SEM document.read: a org nao liga a leitura estruturada.
  vi.mocked(fetchProfile).mockResolvedValue({
    enabled: true, model: "x", instructions: null,
    maxPolicy: { byRole: { admin: ["proposal.list"] }, byRecipient: {}, brokerDefault: [] },
  } as never);
  const resolved: Identity = { kind: "resolved", candidate: CANDIDATO, org: { orgId: ORG, orgName: "RE/MAX Trio", apiToken: "t" } };
  vi.mocked(resolveIdentity).mockResolvedValue(resolved);
});

describe("janela de extracao: o texto da imagem entra como documento_lido", () => {
  const estado = () =>
    ({
      identity: CANDIDATO,
      inbound: { fromPhone: "+5511999990000", text: "segue o RG", messageId: "m-fb-janela" },
      messages: [{ role: "user", content: "quero uma proposta de venda" }],
      piiMap: {},
      model: "x",
    }) as never;

  it("janelaDoTurno usa os lidos do turno quando nao recebe os seus", () => {
    const id = "m-fb-janela";
    registrarLidosDoTurno(id, [{ ref: id, texto: `Texto na imagem: ${TEXTO_DA_IMAGEM}` }]);
    try {
      const d = depsDoFluxo(estado(), []);
      const janela = d.janelaDoTurno!(1);
      expect(janela.lidos).toEqual([{ ref: id, texto: `Texto na imagem: ${TEXTO_DA_IMAGEM}` }]);
      // Se quem chama passa os seus, valem os dele.
      expect(d.janelaDoTurno!(1, []).lidos).toEqual([]);
    } finally {
      registrarLidosDoTurno(id, []);
    }
  });

  it("sem lidos no turno, a janela segue como antes (lidos vazio)", () => {
    const d = depsDoFluxo(estado(), []);
    expect(d.janelaDoTurno!(1).lidos).toEqual([]);
  });
});

describe("no grafo: flag, legenda e custo", () => {
  it("flag off: foto com legenda segue pela legenda e NAO e transcrita", async () => {
    const { reply } = await turno(inboundFoto({ text: "segue o RG do comprador" }));

    expect(transcribeMedia).not.toHaveBeenCalled();
    expect(lerDocumento).not.toHaveBeenCalled();
    expect(reply).toBe("Anotei a legenda.");
  });

  it("flag off: foto sem legenda cai na frase do G5, byte a byte", async () => {
    const { reply } = await turno(inboundFoto());
    expect(reply).toBe(textoSemLeituraDeMidia(null));
    expect(transcribeMedia).not.toHaveBeenCalled();
  });

  it("flag on + legenda: transcreve kind image; o valor nao chega a memoria, ao modelo nem ao checkpoint; custo nao e reportado em dobro", async () => {
    vi.stubEnv("MAX_OCR_TRANSCRIBE_FALLBACK", "true");

    const { reply, values } = await turno(inboundFoto({ text: "segue o RG do comprador" }));

    expect(transcribeMedia).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeMedia).mock.calls[0]![0]).toBe(ORG);
    expect(vi.mocked(transcribeMedia).mock.calls[0]![1]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    expect(reply).toBe("Anotei a legenda.");

    const memoria = JSON.stringify([vi.mocked(extractFacts).mock.calls, vi.mocked(saveFacts).mock.calls]);
    expect(memoria).not.toContain("529.982.247-25");
    expect(memoria).not.toContain("52998224725");
    expect(memoria).not.toContain(NOME);
    const prompts = JSON.stringify(vi.mocked(complete).mock.calls);
    expect(prompts).not.toContain("529.982.247-25");
    expect(prompts).not.toContain(NOME);
    const checkpoint = JSON.stringify(values);
    expect(checkpoint).not.toContain("529.982.247-25");
    expect(checkpoint).not.toContain(NOME);

    // O AIUsage do transcribe e do servidor: o agente so reporta as chamadas de modelo dele
    // (o turno da legenda), e nenhum desses relatorios e da leitura da imagem.
    for (const [, uso] of vi.mocked(reportUsage).mock.calls) {
      expect(JSON.stringify(uso)).not.toMatch(/transcri|image|ocr/i);
    }
  });

  it("flag on mas sem legenda: nem transcreve; a frase do G5", async () => {
    vi.stubEnv("MAX_OCR_TRANSCRIBE_FALLBACK", "true");

    const { reply } = await turno(inboundFoto());

    expect(transcribeMedia).not.toHaveBeenCalled();
    expect(reply).toBe(textoSemLeituraDeMidia(null));
  });
});
