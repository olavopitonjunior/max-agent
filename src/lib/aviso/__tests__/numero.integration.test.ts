import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Aviso } from "../schema";

/**
 * Resposta numérica ao aviso (M7) contra o Postgres de teste: a última linha
 * ENVIADA da outbox do telefone e os turnos de conversa depois dela.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({ seedNotification: vi.fn().mockResolvedValue(undefined) }));

const { enqueue } = await import("../../outbox");
const { query } = await import("../../db");
const { payloadDoNumero } = await import("../numero");

const ORG = "org-test-aviso-numero";
const FONE = "5511987654328";
const OUTRO = "5511911113333";

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
  acoes: [{ id: "ver_formulario" }, { id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }],
  forma: "botoes",
};

async function enviada(chave: string, horasAtras: number, over: { phone?: string; audience?: string; aviso?: Aviso | null } = {}): Promise<string> {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey: chave,
    audience: over.audience ?? "platform_user",
    phone: over.phone ?? FONE,
    recipientName: "Marcia",
    title: "Formulário aguardando",
    body: "corpo",
    linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
    dealId: "deal1",
    orgName: "Imob",
    kind: "form_reminder",
    ...(over.aviso === null ? {} : { aviso: over.aviso ?? AVISO }),
  });
  await query(`UPDATE outbox SET status = 'sent', sent_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
    r.id,
    String(horasAtras),
  ]);
  return r.id;
}

async function turno(phone: string, horasAtras: number, reply: string | null) {
  await query(
    `INSERT INTO conversation_turn (org_id, phone, kind, inbound_text, reply_text, created_at)
     VALUES ($1, $2, 'text', 'oi', $3, now() - ($4 || ' hours')::interval)`,
    [ORG, phone, reply, String(horasAtras)]
  );
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  await query(`DELETE FROM conversation_turn WHERE org_id = $1`, [ORG]);
}

d("resposta numérica ao aviso (Postgres real)", () => {
  beforeEach(limpar);
  afterAll(limpar);

  it("'1' e '2' seguem a lista numerada (o link não conta) e pegam a linha enviada", async () => {
    const id = await enviada("n-basico", 1);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBe(`av:${id}:reenviar_link`);
    expect(await payloadDoNumero(FONE, "2", new Date())).toBe(`av:${id}:lembrar_amanha`);
    expect(await payloadDoNumero(FONE, "3", new Date())).toBeNull();
  });

  it("aceita o telefone com '+' ou formatado (mesma chave da outbox)", async () => {
    const id = await enviada("n-formato", 1);
    expect(await payloadDoNumero("+55 (11) 98765-4328", "2", new Date())).toBe(`av:${id}:lembrar_amanha`);
  });

  it("vale a ÚLTIMA linha enviada, não a mais antiga", async () => {
    await enviada("n-velha", 5);
    const nova = await enviada("n-nova", 2);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBe(`av:${nova}:reenviar_link`);
  });

  it("linha pendente (não enviada) não conta", async () => {
    await enqueue({
      orgId: ORG, dedupeKey: "n-pendente", audience: "platform_user", phone: FONE, recipientName: "Marcia",
      title: "t", body: "b", linkUrl: null, dealId: "deal1", orgName: "Imob", kind: "form_reminder", aviso: AVISO,
    });
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("outro telefone não herda o aviso", async () => {
    await enviada("n-outro", 1);
    expect(await payloadDoNumero(OUTRO, "1", new Date())).toBeNull();
  });

  it("aviso de mais de 12h: null", async () => {
    await enviada("n-velho", 13);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("a última mensagem enviada sem aviso (texto comum) tira o número do aviso anterior", async () => {
    await enviada("n-aviso", 3);
    await enviada("n-texto", 1, { aviso: null });
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("conversa depois do aviso: o '2' é da conversa", async () => {
    await enviada("n-conversa", 3);
    await turno(FONE, 1, "Claro! Qual negócio?");
    expect(await payloadDoNumero(FONE, "2", new Date())).toBeNull();
  });

  it("turno ANTERIOR ao aviso ou turno sem resposta não bloqueiam", async () => {
    const id = await enviada("n-turnos", 2);
    await turno(FONE, 4, "resposta de antes");
    await turno(FONE, 1, null);
    expect(await payloadDoNumero(FONE, "2", new Date())).toBe(`av:${id}:lembrar_amanha`);
  });

  it("parte do negócio (deal_party) nunca", async () => {
    await enviada("n-party", 1, { audience: "deal_party" });
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("linha liquidada dentro de um resumo (mesmo provider_message_id): o '1' não vale", async () => {
    const a = await enviada("n-resumo-a", 1);
    const b = await enviada("n-resumo-b", 1);
    await query(`UPDATE outbox SET provider_message_id = 'MID-RESUMO' WHERE id = ANY($1::text[])`, [[a, b]]);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("marca 'resumo:' (Newton sem messageId, envio incerto): o '1' não vale mesmo com uma linha só", async () => {
    const a = await enviada("n-resumo-marca", 1);
    await query(`UPDATE outbox SET provider_message_id = $2 WHERE id = $1`, [a, `resumo:${a}`]);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBeNull();
  });

  it("provider_message_id único (envio normal) continua valendo", async () => {
    const a = await enviada("n-unico", 1);
    await query(`UPDATE outbox SET provider_message_id = 'MID-UNICO' WHERE id = $1`, [a]);
    expect(await payloadDoNumero(FONE, "1", new Date())).toBe(`av:${a}:reenviar_link`);
  });

  it("lista: a escolha vai por item:<alvoId>", async () => {
    const lista: Aviso = {
      ...AVISO,
      evento: "daily_report",
      forma: "lista",
      acoes: [{ id: "concluir", alvoId: "atv_1" }, { id: "concluir", alvoId: "atv_2" }],
    };
    const id = await enviada("n-lista", 1, { aviso: lista });
    expect(await payloadDoNumero(FONE, "2", new Date())).toBe(`av:${id}:item:atv_2`);
  });
});
