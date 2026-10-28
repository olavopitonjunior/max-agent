import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Capability } from "@/graph/policy";
import type { ContextoDoTurno } from "@/graph/fluxos";
import type { InboundMessage } from "@/lib/transport";
import type { Aviso } from "@/lib/aviso/schema";
import {
  AVISO_VALIDADE_MS,
  ehPayloadDeAviso,
  parsePayloadDeAviso,
  rotearBotaoDeAviso,
  TEXTO_AVISO_ERRO,
  TEXTO_AVISO_EXPIRADO,
  TEXTO_AVISO_INDISPONIVEL,
  TEXTO_AVISO_JA_FEITO,
  TEXTO_AVISO_SEM_PERMISSAO,
  TEXTO_FORMULARIO_CONCLUIDO,
  type DadosDoAviso,
  type LinhaDoAviso,
} from "../aviso-botao";

/**
 * Roteador do toque `av:` (M6), com banco e transporte de mentira. A trava real
 * (`aviso_toque`) e o `deliverAfter` do `enqueue` têm teste de integração à
 * parte (`aviso-botao.integration.test.ts`).
 */

const AGORA = Date.parse("2026-10-28T15:00:00-03:00");
const FONE = "5511987654321";
const usuario = { orgId: "org1", orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };
const corretor = { orgId: "org1", orgName: "Imob", kind: "broker" as const, splitRecipientId: "s1", label: "Beto" };
const COM: Capability[] = ["activity.list", "activity.write", "form.create"];

const AVISO: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário de *Venda Apto 302* ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Ver formulário", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [
    { id: "reenviar_link", alvoId: "f1" },
    { id: "lembrar_amanha" },
    { id: "adiar_1d", alvoId: "atv_9" },
    { id: "concluir", alvoId: "atv_7" },
    { id: "ver_formulario" },
  ],
  forma: "botoes",
};

function linha(over: Partial<LinhaDoAviso> = {}): LinhaDoAviso {
  return {
    id: "row1",
    org_id: "org1",
    phone: FONE,
    audience: "platform_user",
    status: "sent",
    deal_id: "deal1",
    sent_at: new Date(AGORA - 60 * 60_000),
    aviso: AVISO,
    recipient_name: "Ana Souza",
    title: "Formulário aguardando",
    body: "corpo",
    link_url: "https://trio.imobpro.ia.br/deals/cmx1",
    org_name: "RE/MAX Trio",
    kind: "form_reminder",
    params: null,
    ...over,
  };
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "wamid.T1",
    fromPhone: FONE,
    groupId: null,
    kind: "text",
    text: "📨 Reenviar link",
    mediaUrl: null,
    mimeType: null,
    timestampMs: AGORA,
    senderName: null,
    replyToMessageId: null,
    buttonPayload: "av:row1:reenviar_link",
    ...over,
  };
}

function ctx(over: Partial<ContextoDoTurno> = {}): ContextoDoTurno {
  return { texto: "📨 Reenviar link", messageId: "wamid.T1", policy: COM, agora: AGORA, orgName: "Imob", ...over };
}

/** Banco em memória: a trava é um Map, como a PK `(row_id, acao)`. */
function dados(row: LinhaDoAviso | null): DadosDoAviso & { travas: Map<string, string> } {
  const travas = new Map<string, string>();
  return {
    travas,
    carregar: vi.fn(async (id: string) => (row && row.id === id ? row : null)),
    reivindicar: vi.fn(async (rowId: string, acao: string, messageId: string) => {
      const k = `${rowId}:${acao}`;
      const dono = travas.get(k);
      if (dono === undefined) {
        travas.set(k, messageId);
        return true;
      }
      return dono === messageId;
    }),
    liberar: vi.fn(async (rowId: string, acao: string, messageId: string) => {
      const k = `${rowId}:${acao}`;
      if (travas.get(k) === messageId) travas.delete(k);
    }),
  };
}

const executar = vi.fn();
const enfileirar = vi.fn();
const reagir = vi.fn();
const rotearAtividade = vi.fn();

function rodar(over: {
  payload?: string;
  row?: LinhaDoAviso | null;
  banco?: ReturnType<typeof dados>;
  inb?: Partial<InboundMessage>;
  identity?: typeof usuario | typeof corretor;
  c?: Partial<ContextoDoTurno>;
  ocupado?: string;
} = {}) {
  const payload = over.payload ?? "av:row1:reenviar_link";
  const banco = over.banco ?? dados(over.row === undefined ? linha() : over.row);
  return rotearBotaoDeAviso({
    payload,
    inbound: inbound({ buttonPayload: payload, ...over.inb }),
    identity: over.identity ?? usuario,
    ctx: ctx(over.c),
    ler: vi.fn(),
    ocupado: over.ocupado,
    deps: { executar, enfileirar, reagir, rotearAtividade, dados: banco } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  executar.mockResolvedValue({ status: 200, body: { ok: true } });
  enfileirar.mockResolvedValue({ status: "queued", id: "novo", deliverAfter: new Date() });
  reagir.mockResolvedValue(true);
  rotearAtividade.mockResolvedValue({ reply: "Concluir a atividade X? Responda SIM.", fluxo: null, evento: "atividade_botao_x" });
});

describe("payload", () => {
  it("reconhece e separa botão e lista", () => {
    expect(ehPayloadDeAviso("av:row1:abrir")).toBe(true);
    expect(ehPayloadDeAviso("atv:a:concluir")).toBe(false);
    expect(ehPayloadDeAviso(null)).toBe(false);
    expect(parsePayloadDeAviso("av:row1:reenviar_link")).toEqual({ rowId: "row1", acao: "reenviar_link", alvoId: null });
    expect(parsePayloadDeAviso("av:row1:item:atv_1")).toEqual({ rowId: "row1", acao: null, alvoId: "atv_1" });
  });

  it("malformado ou ação fora do enum: null", () => {
    for (const p of ["av:", "av:row1", "av:row1:apagar_tudo", "av:row1:item:", "av:row 1:abrir", "av:row1:abrir:x"]) {
      expect(parsePayloadDeAviso(p)).toBeNull();
    }
  });
});

describe("quem pode tocar (neutro, sem chamar nada)", () => {
  async function semEfeito(r: Promise<{ reply: string }>, esperado = TEXTO_AVISO_INDISPONIVEL) {
    expect((await r).reply).toBe(esperado);
    expect(executar).not.toHaveBeenCalled();
    expect(enfileirar).not.toHaveBeenCalled();
    expect(reagir).not.toHaveBeenCalled();
    expect(rotearAtividade).not.toHaveBeenCalled();
  }

  it("payload malformado", async () => semEfeito(rodar({ payload: "av:row1:apagar_tudo" })));
  it("linha inexistente", async () => semEfeito(rodar({ row: null })));
  it("telefone diferente do que recebeu o aviso", async () =>
    semEfeito(rodar({ inb: { fromPhone: "5511900000000" } })));
  it("telefone igual com formato diferente (+55 e máscara) passa", async () => {
    const r = await rodar({ row: linha({ phone: "+55 (11) 98765-4321" }) });
    expect(r.reply).not.toBe(TEXTO_AVISO_INDISPONIVEL);
  });
  it("org diferente da identidade", async () => semEfeito(rodar({ identity: { ...usuario, orgId: "outra" } })));
  it("linha ainda não enviada", async () => semEfeito(rodar({ row: linha({ status: "pending" }) })));
  it("parte do negócio nunca tem botão", async () => semEfeito(rodar({ row: linha({ audience: "deal_party" }) })));
  it("linha sem aviso", async () => semEfeito(rodar({ row: linha({ aviso: null }) })));
  it("ação que o aviso não tem", async () =>
    semEfeito(rodar({ payload: "av:row1:ver_proposta" })));

  it("73h depois do envio: expirou", async () => {
    await semEfeito(
      rodar({ row: linha({ sent_at: new Date(AGORA - AVISO_VALIDADE_MS - 60 * 60_000) }) }),
      TEXTO_AVISO_EXPIRADO
    );
  });
  it("71h depois do envio: ainda vale", async () => {
    const r = await rodar({ row: linha({ sent_at: new Date(AGORA - 71 * 60 * 60_000) }) });
    expect(r.reply).toContain("Reenviei");
  });
});

describe("abrir / ver_*", () => {
  it("devolve a linha do link, sem reação nem trava", async () => {
    const banco = dados(linha());
    const r = await rodar({ payload: "av:row1:ver_formulario", banco });
    expect(r.reply).toBe("👉 Ver formulário: https://trio.imobpro.ia.br/deals/cmx1");
    expect(reagir).not.toHaveBeenCalled();
    expect(banco.reivindicar).not.toHaveBeenCalled();
    // Tocar de novo devolve o link de novo (não escreve nada).
    expect((await rodar({ payload: "av:row1:ver_formulario", banco })).reply).toContain("👉");
  });
});

describe("reenviar_link", () => {
  it("2xx: executa form.remind com a chave fixa do aviso, responde e reage ✅", async () => {
    const r = await rodar();
    expect(executar).toHaveBeenCalledTimes(1);
    expect(executar).toHaveBeenCalledWith({
      orgId: "org1",
      rawPhone: FONE,
      subject: { kind: "user", userId: "u1" },
      verb: "form.remind",
      args: { deal_id: "deal1", form_id: "f1" },
      idempotencyKey: "av:row1:reenviar_link",
    });
    expect(r.reply).toBe("Pronto! Reenviei o link para quem ainda falta preencher. 👍");
    expect(reagir).toHaveBeenCalledWith({ to: FONE, messageId: "wamid.T1", emoji: "✅" });
    expect(r.fluxo).toBeNull();
  });

  it("o mesmo av: duas vezes: a segunda responde já feito e executar roda 1 vez", async () => {
    const banco = dados(linha());
    const primeira = await rodar({ banco });
    const segunda = await rodar({ banco, inb: { messageId: "wamid.T2" }, c: { messageId: "wamid.T2" } });
    expect(primeira.reply).toContain("Reenviei");
    expect(segunda.reply).toBe(TEXTO_AVISO_JA_FEITO);
    expect(executar).toHaveBeenCalledTimes(1);
    expect(reagir).toHaveBeenCalledTimes(1);
  });

  it("a mesma messageId de novo (reentrega) não é 'já feito': a chave idempotente protege", async () => {
    const banco = dados(linha());
    await rodar({ banco });
    const de_novo = await rodar({ banco });
    expect(de_novo.reply).toContain("Reenviei");
    expect(executar).toHaveBeenCalledTimes(2);
    expect(executar.mock.calls.map((c) => c[0].idempotencyKey)).toEqual(["av:row1:reenviar_link", "av:row1:reenviar_link"]);
  });

  it("403: frase de erro, sem reação, e libera a trava para tentar de novo", async () => {
    executar.mockResolvedValueOnce({ status: 403, body: { error: "forbidden" } });
    const banco = dados(linha());
    const r = await rodar({ banco });
    expect(r.reply).toBe(TEXTO_AVISO_ERRO);
    expect(reagir).not.toHaveBeenCalled();
    expect(banco.travas.size).toBe(0);

    const outra = await rodar({ banco, inb: { messageId: "wamid.T2" }, c: { messageId: "wamid.T2" } });
    expect(outra.reply).toContain("Reenviei");
  });

  it("erro incerto (5xx, null, exceção) no meio: o toque seguinte tenta de novo com a MESMA chave", async () => {
    executar.mockResolvedValueOnce({ status: 503, body: {} });
    const banco = dados(linha());
    const a = await rodar({ banco });
    const b = await rodar({ banco, inb: { messageId: "wamid.T2" }, c: { messageId: "wamid.T2" } });
    expect(a.reply).toBe(TEXTO_AVISO_ERRO);
    expect(b.reply).toContain("Reenviei");
    expect(executar).toHaveBeenCalledTimes(2);
    expect(executar.mock.calls.map((c) => c[0].idempotencyKey)).toEqual(["av:row1:reenviar_link", "av:row1:reenviar_link"]);
  });

  it("adiar_1d: erro e nova tentativa também usam a mesma chave", async () => {
    executar.mockResolvedValueOnce(null);
    const banco = dados(linha());
    await rodar({ payload: "av:row1:adiar_1d", banco });
    await rodar({ payload: "av:row1:adiar_1d", banco, inb: { messageId: "wamid.T2" }, c: { messageId: "wamid.T2" } });
    expect(executar.mock.calls.map((c) => c[0].idempotencyKey)).toEqual(["av:row1:adiar_1d", "av:row1:adiar_1d"]);
  });

  it("409 concluido: formulário já preenchido, mantém a trava e não reage", async () => {
    executar.mockResolvedValueOnce({ status: 409, body: { error: "Conflict", reason: "concluido" } });
    const banco = dados(linha());
    const r = await rodar({ banco });
    expect(r.reply).toBe("Esse formulário já foi preenchido. Nada foi alterado.");
    expect(r.reply).toBe(TEXTO_FORMULARIO_CONCLUIDO);
    expect(reagir).not.toHaveBeenCalled();
    expect(banco.travas.size).toBe(1);
    // Outro toque não repete a chamada: a trava segura.
    const outra = await rodar({ banco, inb: { messageId: "wamid.T2" }, c: { messageId: "wamid.T2" } });
    expect(outra.reply).toBe(TEXTO_AVISO_JA_FEITO);
    expect(executar).toHaveBeenCalledTimes(1);
  });

  it("409 com outro motivo continua sendo erro genérico, com a trava liberada", async () => {
    executar.mockResolvedValueOnce({ status: 409, body: { error: "Conflict", reason: "outro" } });
    const banco = dados(linha());
    expect((await rodar({ banco })).reply).toBe(TEXTO_AVISO_ERRO);
    expect(banco.travas.size).toBe(0);
  });

  it("null (sem resposta) e exceção: mesma frase de erro", async () => {
    executar.mockResolvedValueOnce(null);
    expect((await rodar()).reply).toBe(TEXTO_AVISO_ERRO);
    executar.mockRejectedValueOnce(new Error("boom"));
    expect((await rodar({ inb: { messageId: "wamid.T3" } })).reply).toBe(TEXTO_AVISO_ERRO);
    expect(reagir).not.toHaveBeenCalled();
  });

  it("corretor sem login, sem permissão ou política fora do ar: nada é executado", async () => {
    expect((await rodar({ identity: corretor })).reply).toBe(TEXTO_AVISO_INDISPONIVEL);
    expect((await rodar({ c: { policy: ["activity.list"] } })).reply).toBe(TEXTO_AVISO_SEM_PERMISSAO);
    expect((await rodar({ c: { politicaIndisponivel: true } })).reply).toBe(TEXTO_AVISO_ERRO);
    expect(executar).not.toHaveBeenCalled();
  });

  it("sem alvoId ou sem deal_id: indisponível, sem chamar executar", async () => {
    const semAlvo = linha({ aviso: { ...AVISO, acoes: [{ id: "reenviar_link" }] } });
    expect((await rodar({ row: semAlvo })).reply).toBe(TEXTO_AVISO_INDISPONIVEL);
    expect((await rodar({ row: linha({ deal_id: null }) })).reply).toBe(TEXTO_AVISO_INDISPONIVEL);
    expect(executar).not.toHaveBeenCalled();
  });
});

describe("adiar_1d", () => {
  it("activity.postpone com a atividade e 1 dia", async () => {
    const r = await rodar({ payload: "av:row1:adiar_1d" });
    expect(executar).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "activity.postpone", args: { atividade_id: "atv_9", dias: 1 }, idempotencyKey: "av:row1:adiar_1d" })
    );
    expect(r.reply).toBe("Pronto! Adiei para amanhã. 📅");
    expect(reagir).toHaveBeenCalledTimes(1);
  });

  it("exige activity.write", async () => {
    const r = await rodar({ payload: "av:row1:adiar_1d", c: { policy: ["form.create"] } });
    expect(r.reply).toBe(TEXTO_AVISO_SEM_PERMISSAO);
    expect(executar).not.toHaveBeenCalled();
  });
});

describe("lembrar_amanha", () => {
  it("enfileira a cópia da linha amanhã às 9h de São Paulo, com chave própria", async () => {
    const r = await rodar({ payload: "av:row1:lembrar_amanha" });
    expect(r.reply).toBe("Combinado! Te lembro amanhã às 9h. ⏰");
    expect(enfileirar).toHaveBeenCalledTimes(1);
    const p = enfileirar.mock.calls[0]![0];
    expect(p).toMatchObject({
      orgId: "org1",
      dedupeKey: "lembrete:row1",
      audience: "platform_user",
      phone: FONE,
      recipientName: "Ana Souza",
      dealId: "deal1",
      orgName: "RE/MAX Trio",
      kind: "form_reminder",
      aviso: AVISO,
    });
    // 28/10 15h em SP -> 29/10 09h em SP = 12:00 UTC.
    expect(p.deliverAfter.toISOString()).toBe("2026-10-29T12:00:00.000Z");
    expect(reagir).toHaveBeenCalledTimes(1);
  });

  it("vale também para corretor (só escreve na própria fila) e não chama executar", async () => {
    const r = await rodar({ payload: "av:row1:lembrar_amanha", identity: corretor });
    expect(r.reply).toContain("Combinado");
    expect(executar).not.toHaveBeenCalled();
  });

  it("segundo toque: já feito, um lembrete só", async () => {
    const banco = dados(linha());
    await rodar({ payload: "av:row1:lembrar_amanha", banco });
    const r = await rodar({ payload: "av:row1:lembrar_amanha", banco, inb: { messageId: "wamid.T2" } });
    expect(r.reply).toBe(TEXTO_AVISO_JA_FEITO);
    expect(enfileirar).toHaveBeenCalledTimes(1);
  });

  it("falha ao enfileirar: erro e trava liberada", async () => {
    enfileirar.mockRejectedValueOnce(new Error("db"));
    const banco = dados(linha());
    const r = await rodar({ payload: "av:row1:lembrar_amanha", banco });
    expect(r.reply).toBe(TEXTO_AVISO_ERRO);
    expect(banco.travas.size).toBe(0);
    expect(reagir).not.toHaveBeenCalled();
  });
});

describe("concluir / criar_atividade (próximo passo)", () => {
  it("delega ao roteador de atividade com atv:<alvoId>:concluir, sem reação nem trava", async () => {
    const banco = dados(linha());
    const r = await rodar({ payload: "av:row1:concluir", banco });
    expect(rotearAtividade).toHaveBeenCalledTimes(1);
    expect(rotearAtividade.mock.calls[0]![0]).toMatchObject({ payload: "atv:atv_7:concluir", identity: usuario });
    expect(r.reply).toBe("Concluir a atividade X? Responda SIM.");
    expect(reagir).not.toHaveBeenCalled();
    expect(banco.reivindicar).not.toHaveBeenCalled();
    expect(executar).not.toHaveBeenCalled();
  });

  it("criar_atividade não escreve: devolve o link do negócio, sem executar, sem roteador, sem reação, sem trava", async () => {
    const row = linha({ aviso: { ...AVISO, acoes: [{ id: "criar_atividade", alvoId: "n1" }] } });
    const banco = dados(row);
    const r = await rodar({ payload: "av:row1:criar_atividade", banco });
    expect(r.reply).toBe("Para criar o próximo passo, abra o negócio no sistema.\n👉 Abrir negócio: https://trio.imobpro.ia.br/deals/cmx1");
    expect(executar).not.toHaveBeenCalled();
    expect(rotearAtividade).not.toHaveBeenCalled();
    expect(reagir).not.toHaveBeenCalled();
    expect(banco.reivindicar).not.toHaveBeenCalled();
  });

  it("criar_atividade vale sem alvoId, sem política e com escrita em aberto; sem link, indisponível", async () => {
    const row = linha({ aviso: { ...AVISO, acoes: [{ id: "criar_atividade" }] } });
    const sem = await rodar({ payload: "av:row1:criar_atividade", row, identity: corretor, c: { policy: [] }, ocupado: "Antes, termine." });
    expect(sem.reply).toContain("Para criar o próximo passo");
    const semLink = linha({ link_url: null, aviso: { ...AVISO, link: null, acoes: [{ id: "criar_atividade" }] } });
    expect((await rodar({ payload: "av:row1:criar_atividade", row: semLink })).reply).toBe(TEXTO_AVISO_INDISPONIVEL);
    expect(executar).not.toHaveBeenCalled();
    expect(rotearAtividade).not.toHaveBeenCalled();
  });

  it("com escrita em aberto: responde o 'termine o pedido' e não delega", async () => {
    const r = await rodar({ payload: "av:row1:concluir", ocupado: "Antes, vamos terminar o pedido." });
    expect(r.reply).toBe("Antes, vamos terminar o pedido.");
    expect(rotearAtividade).not.toHaveBeenCalled();
  });

  it("ocupado não bloqueia as ações diretas", async () => {
    const r = await rodar({ payload: "av:row1:lembrar_amanha", ocupado: "Antes, vamos terminar o pedido." });
    expect(r.reply).toContain("Combinado");
  });

  it("sem alvoId: indisponível", async () => {
    const row = linha({ aviso: { ...AVISO, acoes: [{ id: "concluir" }] } });
    expect((await rodar({ payload: "av:row1:concluir", row })).reply).toBe(TEXTO_AVISO_INDISPONIVEL);
    expect(rotearAtividade).not.toHaveBeenCalled();
  });
});

describe("lista (item:<alvoId>)", () => {
  const LISTA: Aviso = {
    ...AVISO,
    evento: "daily_report",
    forma: "lista",
    itens: ["Ligar para o João", "Enviar proposta"],
    acoes: [
      { id: "concluir", alvoId: "atv_1" },
      { id: "abrir", alvoId: "atv_2" },
    ],
  };

  it("a linha tocada vira a ação com aquele alvoId (concluir -> fluxo de atividade)", async () => {
    await rodar({ payload: "av:row1:item:atv_1", row: linha({ aviso: LISTA }) });
    expect(rotearAtividade.mock.calls[0]![0].payload).toBe("atv:atv_1:concluir");
  });

  it("linha de ação 'abrir': devolve o link do aviso", async () => {
    const r = await rodar({ payload: "av:row1:item:atv_2", row: linha({ aviso: LISTA }) });
    expect(r.reply).toContain("👉");
    expect(r.reply).toContain("https://trio.imobpro.ia.br/deals/cmx1");
  });

  it("alvoId que não está no aviso: indisponível", async () => {
    const r = await rodar({ payload: "av:row1:item:outro", row: linha({ aviso: LISTA }) });
    expect(r.reply).toBe(TEXTO_AVISO_INDISPONIVEL);
  });
});
