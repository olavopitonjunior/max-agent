import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Aviso } from "../aviso/schema";

/**
 * Despacho do `aviso` (M5): botões (B) e marco (C) na Meta, texto no Newton.
 * Postgres de teste; Meta e Z-API NUNCA são chamadas (transporte mockado e
 * `fetch` de mentira).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("@/graph/graph", () => ({
  seedNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../identity", () => ({
  resolveIdentity: vi.fn().mockResolvedValue({ kind: "unknown" }),
}));
vi.mock("../meta", async (orig) => ({
  ...(await orig<typeof import("../meta")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "MID-T" }),
  sendInteractive: vi.fn().mockResolvedValue({ messageId: "MID-I" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue } = await import("../outbox");
const { MetaHttpError } = await import("../transport/erro");
const { query } = await import("../db");
const meta = await import("../meta");

const sendText = meta.sendText as unknown as ReturnType<typeof vi.fn>;
const sendInteractive = meta.sendInteractive as unknown as ReturnType<typeof vi.fn>;

const FONE = "5511987654321";

const AVISO_B: Aviso = {
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
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const AVISO_C: Aviso = {
  v: 1,
  evento: "contract_signed",
  nivel: "C",
  emoji: "✅",
  titulo: "Contrato assinado",
  negocio: "Venda Apto 302",
  frase: "Todas as partes assinaram o contrato de *Venda Apto 302*.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "abrir" }, { id: "criar_atividade", alvoId: "n1" }],
  forma: "botoes",
  imagemUrl: "https://trio.imobpro.ia.br/og/marco?t=abc",
};

function args(over: Partial<Parameters<typeof enqueue>[0]> = {}) {
  return {
    orgId: "org-test-aviso",
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    audience: "platform_user",
    phone: FONE,
    recipientName: "Ana Souza",
    title: "Formulário aguardando",
    body: "corpo antigo",
    linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
    dealId: "deal1",
    orgName: "RE/MAX Trio",
    ...over,
  };
}

async function despachar(dedupeKey: string) {
  await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE dedupe_key = $1`, [dedupeKey]);
  return dispatchDue();
}

d("despacho do aviso (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ messageId: "MID-T" });
    sendInteractive.mockResolvedValue({ messageId: "MID-I" });
    await query(`DELETE FROM outbox WHERE org_id = 'org-test-aviso'`);
    await query(
      `INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE SET last_inbound_at = now()`,
      [FONE]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = 'org-test-aviso'`);
    await query(`DELETE FROM conversation_window WHERE phone = '${FONE}'`);
  });

  it("janela aberta + Meta: B sai como botões, com os ids da linha e sem o link repetido no corpo", async () => {
    const r = await enqueue(args({ dedupeKey: "k-b", kind: "form_reminder", aviso: AVISO_B }));
    const id = r.id;
    await despachar("k-b");

    expect(sendText).not.toHaveBeenCalled();
    expect(sendInteractive).toHaveBeenCalledTimes(1);
    const { interativo, to } = sendInteractive.mock.calls[0][0];
    expect(to).toBe(FONE);
    expect(interativo.tipo).toBe("botoes");
    expect(interativo.opcoes.map((o: { id: string }) => o.id)).toEqual([
      `av:${id}:reenviar_link`,
      `av:${id}:lembrar_amanha`,
      `av:${id}:ver_formulario`,
    ]);
    expect(interativo.opcoes.map((o: { titulo: string }) => o.titulo)).toEqual([
      "📨 Reenviar link",
      "⏰ Me lembra amanhã",
      "🔗 Ver formulário",
    ]);
    // O link vem pelo botão "Ver formulário": a linha 👉 sai do corpo interativo.
    expect(interativo.corpo).toContain("Oi, Ana! ⏳ *Formulário aguardando*");
    expect(interativo.corpo).not.toContain("👉");
    expect(interativo.imagemUrl).toBeUndefined();

    const [row] = await query<{ status: string; provider_message_id: string }>(
      `SELECT status, provider_message_id FROM outbox WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ status: "sent", provider_message_id: "MID-I" });
  });

  it("C com imagemUrl: botões com cabeçalho de imagem", async () => {
    await enqueue(args({ dedupeKey: "k-c", kind: "contract_signed", aviso: AVISO_C }));
    await despachar("k-c");
    const { interativo } = sendInteractive.mock.calls[0][0];
    expect(interativo.imagemUrl).toBe("https://trio.imobpro.ia.br/og/marco?t=abc");
    expect(interativo.opcoes).toHaveLength(2);
  });

  it("A (só texto): sendText, sem interativo", async () => {
    const a: Aviso = { ...AVISO_B, nivel: "A", evento: "stage_change", acoes: [{ id: "abrir" }] };
    await enqueue(args({ dedupeKey: "k-a", kind: "stage_change", aviso: a }));
    await despachar("k-a");
    expect(sendInteractive).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].body).toContain("👉 Ver formulário: https://trio.imobpro.ia.br/deals/cmx1");
  });

  it("deal_party nunca ganha botão nem imagem, mesmo que o aviso chegue com ações", async () => {
    await enqueue(args({ dedupeKey: "k-party", audience: "deal_party", kind: "contract_signed", aviso: AVISO_C }));
    await despachar("k-party");
    expect(sendInteractive).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);
    const [row] = await query<{ aviso: Aviso }>(`SELECT aviso FROM outbox WHERE dedupe_key = 'k-party'`);
    expect(row.aviso.acoes).toEqual([]);
    expect(row.aviso.imagemUrl).toBeUndefined();
  });

  it("MAX_INTERACTIVE=off: texto único, com o link no texto", async () => {
    vi.stubEnv("MAX_INTERACTIVE", "off");
    try {
      await enqueue(args({ dedupeKey: "k-off", kind: "form_reminder", aviso: AVISO_B }));
      await despachar("k-off");
      expect(sendInteractive).not.toHaveBeenCalled();
      expect(sendText.mock.calls[0][0].body).toContain("👉 Ver formulário:");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a Meta recusa a forma (400): cai no texto completo, com o link", async () => {
    sendInteractive.mockRejectedValueOnce(new MetaHttpError("/x/messages", 400, JSON.stringify({ error: { code: 100, message: "bad" } })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await enqueue(args({ dedupeKey: "k-400", kind: "form_reminder", aviso: AVISO_B }));
      await despachar("k-400");
    } finally {
      warn.mockRestore();
    }
    expect(sendInteractive).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0].body).toContain("👉 Ver formulário: https://trio.imobpro.ia.br/deals/cmx1");
  });

  it("janela fechada: caminho de template de hoje, sem interativo nem texto livre", async () => {
    await query(`DELETE FROM conversation_window WHERE phone = '${FONE}'`);
    await enqueue(args({ dedupeKey: "k-fechada", kind: "form_reminder", aviso: AVISO_B }));
    await despachar("k-fechada");
    expect(sendInteractive).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    const [row] = await query<{ status: string }>(`SELECT status FROM outbox WHERE dedupe_key = 'k-fechada'`);
    expect(row.status).not.toBe("sent");
  });

  it("perfil newton: só texto, sem interativo, sem tocar na Meta", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    vi.stubEnv("NEWTON_BRIDGE_URL", "https://bridge.test");
    vi.stubEnv("NEWTON_BRIDGE_TOKEN", "tok-teste");
    const corpos: Array<{ to: string; body: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      corpos.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ provider: "zapi", messageId: "Z1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await query(`DELETE FROM conversation_window WHERE phone = '${FONE}'`);
      await enqueue(args({ dedupeKey: "k-newton", kind: "form_reminder", aviso: AVISO_B }));
      await despachar("k-newton");
      expect(sendInteractive).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(corpos).toHaveLength(1);
      expect(corpos[0].body).toContain("Oi, Ana! ⏳ *Formulário aguardando*");
      // Sem botão, o Newton recebe o bloco numerado (a resposta "2" é tratada por `aviso/numero.ts`).
      expect(corpos[0].body).toContain("Responda:\n*1* · reenviar link\n*2* · lembrar amanhã");
      expect(Object.keys(corpos[0])).not.toContain("interactive");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
