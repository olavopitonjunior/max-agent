import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Aviso } from "../aviso/schema";

/**
 * Roteador do toque `av:` (M6) contra o Postgres de teste: a linha da outbox, a
 * trava `aviso_toque` (migration 028) e o lembrete agendado pelo `enqueue` real
 * com `deliverAfter`. Executar/reagir são mocks: nada vai para o ImobPro nem
 * para a Meta.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn().mockResolvedValue(undefined) }));

const { enqueue } = await import("../outbox");
const { query } = await import("../db");
const { rotearBotaoDeAviso, dadosDoAviso } = await import("../aviso-botao");

const ORG = "org-test-aviso-botao";
const FONE = "5511987654329";
const usuario = { orgId: ORG, orgName: "Imob", kind: "user" as const, userId: "u1", userName: "Marcia" };

const AVISO: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Ver formulário", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const executar = vi.fn();
const reagir = vi.fn();
const rotearAtividade = vi.fn();

async function linhaEnviada(chave: string, diasAtras = 0): Promise<string> {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey: chave,
    audience: "platform_user",
    phone: FONE,
    recipientName: "Marcia",
    title: "Formulário aguardando",
    body: "corpo",
    linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
    dealId: "deal1",
    orgName: "Imob",
    kind: "form_reminder",
    aviso: AVISO,
  });
  await query(`UPDATE outbox SET status = 'sent', sent_at = now() - ($2 || ' days')::interval WHERE id = $1`, [
    r.id,
    String(diasAtras),
  ]);
  return r.id;
}

function toque(rowId: string, acao: string, messageId: string, fone = FONE) {
  return rotearBotaoDeAviso({
    payload: `av:${rowId}:${acao}`,
    inbound: {
      messageId, fromPhone: fone, groupId: null, kind: "text", text: "x", mediaUrl: null, mimeType: null,
      timestampMs: Date.now(), senderName: null, replyToMessageId: null, buttonPayload: `av:${rowId}:${acao}`,
    },
    identity: usuario,
    ctx: { texto: "x", messageId, policy: ["form.create", "activity.write", "activity.list"], agora: Date.now(), orgName: "Imob" },
    ler: vi.fn(),
    deps: { executar, enfileirar: enqueue, reagir, rotearAtividade },
  });
}

async function limpar() {
  await query(`DELETE FROM aviso_toque WHERE row_id IN (SELECT id FROM outbox WHERE org_id = $1)`, [ORG]);
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
}

d("toque em botão de aviso (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    executar.mockResolvedValue({ status: 200, body: { ok: true } });
    reagir.mockResolvedValue(true);
    await limpar();
  });
  afterAll(limpar);

  it("reenviar_link: segunda mensagem de toque responde já feito e executa 1 vez só", async () => {
    const id = await linhaEnviada("ab-reenviar");
    const a = await toque(id, "reenviar_link", "wamid.A1");
    const b = await toque(id, "reenviar_link", "wamid.A2");
    expect(a.reply).toContain("Reenviei");
    expect(b.reply).toBe("Isso já foi feito. 👍");
    expect(executar).toHaveBeenCalledTimes(1);
    expect(executar.mock.calls[0]![0]).toMatchObject({ verb: "form.remind", idempotencyKey: "wamid.A1" });
  });

  it("a mesma messageId de novo (reentrega) passa pela trava; outra mensagem não", async () => {
    const id = await linhaEnviada("ab-reentrega");
    expect(await dadosDoAviso.reivindicar(id, "adiar_1d", "m1")).toBe(true);
    expect(await dadosDoAviso.reivindicar(id, "adiar_1d", "m1")).toBe(true);
    expect(await dadosDoAviso.reivindicar(id, "adiar_1d", "m2")).toBe(false);
    // Outra ação da mesma linha é outra trava.
    expect(await dadosDoAviso.reivindicar(id, "lembrar_amanha", "m2")).toBe(true);
    // Liberar só vale para quem reivindicou.
    await dadosDoAviso.liberar(id, "adiar_1d", "m2");
    expect(await dadosDoAviso.reivindicar(id, "adiar_1d", "m3")).toBe(false);
    await dadosDoAviso.liberar(id, "adiar_1d", "m1");
    expect(await dadosDoAviso.reivindicar(id, "adiar_1d", "m3")).toBe(true);
  });

  it("erro do servidor libera a trava: o toque seguinte funciona", async () => {
    const id = await linhaEnviada("ab-erro");
    executar.mockResolvedValueOnce({ status: 403, body: { error: "forbidden" } });
    const a = await toque(id, "reenviar_link", "wamid.B1");
    const b = await toque(id, "reenviar_link", "wamid.B2");
    expect(a.reply).toBe("Não consegui agora. Nada foi alterado; tente de novo em instantes.");
    expect(b.reply).toContain("Reenviei");
    expect(reagir).toHaveBeenCalledTimes(1);
  });

  it("telefone diferente: neutro, nada executado nem reivindicado", async () => {
    const id = await linhaEnviada("ab-fone");
    const r = await toque(id, "reenviar_link", "wamid.C1", "5511911112222");
    expect(r.reply).toBe("Não encontrei esse aviso. Nada foi alterado.");
    expect(executar).not.toHaveBeenCalled();
    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM aviso_toque WHERE row_id = $1`, [id]);
    expect(n).toBe("0");
  });

  it("enviado há 4 dias: expirou", async () => {
    const id = await linhaEnviada("ab-expirou", 4);
    expect((await toque(id, "reenviar_link", "wamid.D1")).reply).toBe("Esse aviso expirou. Abra o negócio pelo sistema.");
    expect(executar).not.toHaveBeenCalled();
  });

  it("lembrar_amanha: grava uma linha pendente com deliverAfter de amanhã 9h SP e dedupe lembrete:<id>", async () => {
    const id = await linhaEnviada("ab-lembrar");
    const r = await toque(id, "lembrar_amanha", "wamid.E1");
    expect(r.reply).toBe("Combinado! Te lembro amanhã às 9h. ⏰");
    const rows = await query<{ status: string; deliver_after: Date; phone: string; deal_id: string; aviso: Aviso }>(
      `SELECT status, deliver_after, phone, deal_id, aviso FROM outbox WHERE dedupe_key = $1`,
      [`lembrete:${id}`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", phone: FONE, deal_id: "deal1" });
    expect(rows[0]!.aviso.acoes).toEqual(AVISO.acoes);
    // 9h em SP = 12:00 UTC, no dia seguinte (SP) ao de agora.
    expect(rows[0]!.deliver_after.getUTCHours()).toBe(12);
    expect(rows[0]!.deliver_after.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]!.deliver_after.getTime()).toBeLessThanOrEqual(Date.now() + 48 * 60 * 60_000);

    // Segundo toque: não cria segundo lembrete.
    expect((await toque(id, "lembrar_amanha", "wamid.E2")).reply).toBe("Isso já foi feito. 👍");
    const [{ n }] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE org_id = $1`, [ORG]);
    expect(n).toBe("2");
  });
});

d("enqueue com deliverAfter", () => {
  afterAll(limpar);

  it("deliverAfter explícito vale; sem ele, continua o próximo horário de janela", async () => {
    const quando = new Date(Date.now() + 36 * 60 * 60_000);
    const base = {
      orgId: ORG, audience: "platform_user", phone: FONE, recipientName: "Marcia", title: "t", body: "b",
      linkUrl: null, dealId: null, orgName: "Imob",
    };
    const a = await enqueue({ ...base, dedupeKey: "da-explicito", deliverAfter: quando });
    const b = await enqueue({ ...base, dedupeKey: "da-padrao" });
    expect(a.status === "queued" && a.deliverAfter.toISOString()).toBe(quando.toISOString());
    expect(b.status === "queued" && b.deliverAfter.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
    const [row] = await query<{ deliver_after: Date }>(`SELECT deliver_after FROM outbox WHERE dedupe_key = 'da-explicito'`);
    expect(row.deliver_after.toISOString()).toBe(quando.toISOString());
  });
});
