import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `aviso` (v1) no /notify: válido é repassado à fila; malformado é descartado
 * sem erro (o aviso é enfeite — sai o title/body de hoje); para `deal_party`
 * nunca vai com ação nem imagem. Mesmo arranjo do routes.test.ts: abaixo da
 * rota tudo mockado.
 */
vi.mock("@/lib/outbox", () => ({
  enqueue: vi.fn().mockResolvedValue({ status: "queued", id: "out-1", deliverAfter: new Date() }),
}));
vi.mock("@/lib/orgs", () => ({ isOrgKnown: vi.fn().mockResolvedValue(true) }));

const { POST: notifyPost } = await import("../notify/route");
const { enqueue } = await import("@/lib/outbox");
const { sign } = await import("@/lib/hmac");
const enfileira = enqueue as unknown as ReturnType<typeof vi.fn>;

const SECRET = "hmac-secret-de-teste";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const AVISO = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário de *Venda Apto 302* ainda não foi preenchido.",
  itens: ["Ana Souza"],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const BASE = {
  orgId: "org1",
  audience: "deal_broker",
  phone: "+5511987654321",
  recipientName: "Ana Corretora",
  title: "Formulário aguardando",
  body: "O formulário ainda não foi preenchido.",
  linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
  dealId: "cmx1",
  orgName: "RE/MAX Trio",
  dedupeKey: "log-abc",
  kind: "form_reminder",
};

async function postar(corpo: Record<string, unknown>) {
  const body = JSON.stringify(corpo);
  const ts = String(Date.now());
  return notifyPost(
    new NextRequest("http://max.test/api/notify", {
      method: "POST",
      body,
      headers: { "x-max-timestamp": ts, "x-max-signature": sign(ts, body, SECRET) },
    })
  );
}

describe("POST /api/notify × aviso", () => {
  it("aviso válido é repassado igual à fila", async () => {
    const res = await postar({ ...BASE, aviso: AVISO });
    expect(res.status).toBe(202);
    expect(enfileira).toHaveBeenCalledWith(expect.objectContaining({ aviso: AVISO }));
  });

  it("sem aviso: aviso null na fila (payload de hoje continua igual)", async () => {
    const res = await postar(BASE);
    expect(res.status).toBe(202);
    expect(enfileira.mock.calls[0][0].aviso).toBeNull();
  });

  it("aviso malformado: 202 e aviso null, title/body intactos", async () => {
    const res = await postar({
      ...BASE,
      aviso: { ...AVISO, acoes: [{ id: "abrir" }, { id: "abrir" }, { id: "abrir" }, { id: "abrir" }] },
    });
    expect(res.status).toBe(202);
    const arg = enfileira.mock.calls[0][0];
    expect(arg.aviso).toBeNull();
    expect(arg.title).toBe(BASE.title);
    expect(arg.body).toBe(BASE.body);
  });

  it.each([
    ["lixo", "isto não é objeto"],
    ["versão futura", { ...AVISO, v: 2 }],
    ["titulo gigante", { ...AVISO, titulo: "a".repeat(121) }],
  ])("aviso inválido (%s) vira null sem recusar o envio", async (_n, aviso) => {
    const res = await postar({ ...BASE, aviso });
    expect(res.status).toBe(202);
    expect(enfileira.mock.calls[0][0].aviso).toBeNull();
  });

  it("deal_party com ações: grava aviso com acoes [], forma null e sem imagemUrl", async () => {
    const res = await postar({
      ...BASE,
      audience: "deal_party",
      aviso: { ...AVISO, nivel: "C", imagemUrl: "https://x.test/a.png?sig=1", forma: "botoes" },
    });
    expect(res.status).toBe(202);
    const gravado = enfileira.mock.calls[0][0].aviso;
    expect(gravado.acoes).toEqual([]);
    expect(gravado.forma).toBeNull();
    expect("imagemUrl" in gravado).toBe(false);
    expect(gravado.titulo).toBe(AVISO.titulo);
  });
});
