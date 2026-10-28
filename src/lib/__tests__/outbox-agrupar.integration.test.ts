import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Aviso } from "../aviso/schema";

/**
 * Agrupamento de rajadas (M8): o 1º aviso de um negócio sai na hora; o que chega
 * enquanto um irmão saiu há menos de 10 min espera até `sent_at + 10 min` e sai
 * como UM resumo. Postgres de teste; Meta e Newton NUNCA são chamados (transporte
 * mockado e `fetch` de mentira).
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
const { atrasoDeAgrupamento } = await import("../aviso/agrupar");
const { nextDeliveryTime } = await import("../window");
const { query } = await import("../db");
const meta = await import("../meta");
const graph = await import("@/graph/graph");

const sendText = meta.sendText as unknown as ReturnType<typeof vi.fn>;
const sendInteractive = meta.sendInteractive as unknown as ReturnType<typeof vi.fn>;
const seedNotification = graph.seedNotification as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-test-agrupar";
const FONE = "5511987654321";
const FONE2 = "5511912345678";
const LINK = "https://trio.imobpro.ia.br/deals/cmx1";
const DEZ_MIN = 10 * 60_000;

const AVISO_A: Aviso = {
  v: 1,
  evento: "stage_change",
  nivel: "A",
  emoji: "📌",
  titulo: "Etapa mudou",
  negocio: "Venda Apto 302",
  frase: "A etapa de *Venda Apto 302* mudou.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: LINK },
  acoes: [{ id: "abrir" }],
  forma: null,
};

const AVISO_B: Aviso = {
  ...AVISO_A,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const AVISO_C: Aviso = {
  ...AVISO_A,
  evento: "contract_signed",
  nivel: "C",
  emoji: "✅",
  titulo: "Contrato assinado",
  acoes: [{ id: "abrir" }, { id: "criar_atividade", alvoId: "n1" }],
  forma: "botoes",
  imagemUrl: "https://trio.imobpro.ia.br/og/marco?t=abc",
};

const aviso = (base: Aviso, titulo: string): Aviso => ({ ...base, titulo });

let seq = 0;
function args(over: Partial<Parameters<typeof enqueue>[0]> = {}) {
  seq += 1;
  return {
    orgId: ORG,
    dedupeKey: `k-agr-${seq}-${Math.random().toString(36).slice(2)}`,
    audience: "platform_user",
    phone: FONE,
    recipientName: "Ana Souza",
    title: "x",
    body: "corpo antigo",
    linkUrl: LINK,
    dealId: "deal-agr-1",
    orgName: "RE/MAX Trio",
    kind: "stage_change",
    ...over,
  };
}

/** Enfileira um aviso e devolve o id + o `deliverAfter` calculado. */
async function enfileirar(a: Aviso, over: Partial<Parameters<typeof enqueue>[0]> = {}) {
  const r = await enqueue(args({ aviso: a, kind: a.evento, ...over }));
  if (r.status !== "queued") throw new Error("duplicado?");
  return r;
}

/** O que a fila já mandou antes: o irmão enviado há `min` minutos. */
async function irmaoEnviado(a: Aviso, min: number, over: Partial<Parameters<typeof enqueue>[0]> = {}) {
  const r = await enfileirar(a, over);
  await query(
    `UPDATE outbox SET status = 'sent', provider_message_id = 'MID-IRMAO',
            sent_at = now() - ($2 || ' minutes')::interval, deliver_after = now() - interval '1 hour'
      WHERE id = $1`,
    [r.id, String(min)]
  );
  return r;
}

async function vencer(...ids: string[]) {
  await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE id = ANY($1::text[])`, [ids]);
}

interface Saida {
  via: "texto" | "interativo";
  to: string;
  texto: string;
  interativo?: { tipo: string; corpo: string; opcoes: Array<{ id: string; titulo: string }>; imagemUrl?: string };
}
function saidas(): Saida[] {
  const out: Saida[] = [];
  for (const [p] of sendText.mock.calls) out.push({ via: "texto", to: p.to, texto: p.body });
  for (const [p] of sendInteractive.mock.calls) {
    out.push({ via: "interativo", to: p.to, texto: p.interativo.corpo, interativo: p.interativo });
  }
  return out;
}

async function linha(id: string) {
  const [r] = await query<{
    status: string;
    attempts: number;
    provider_message_id: string | null;
    last_error: string | null;
    send_started_at: Date | null;
    deliver_after: Date;
    group_key: string | null;
  }>(
    `SELECT status, attempts, provider_message_id, last_error, send_started_at, deliver_after, group_key
       FROM outbox WHERE id = $1`,
    [id]
  );
  return r;
}

d("agrupar rajadas por negócio (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ messageId: "MID-T" });
    sendInteractive.mockResolvedValue({ messageId: "MID-I" });
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    for (const f of [FONE, FONE2]) {
      await query(
        `INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, now())
         ON CONFLICT (phone) DO UPDATE SET last_inbound_at = now()`,
        [f]
      );
    }
  });

  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    await query(`DELETE FROM conversation_window WHERE phone = ANY($1::text[])`, [[FONE, FONE2]]);
  });

  describe("atrasoDeAgrupamento", () => {
    it("sem irmão enviado: null", async () => {
      expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", "A")).toBeNull();
    });

    it("irmão enviado há 3 min: sent_at + 10 min", async () => {
      await irmaoEnviado(AVISO_A, 3);
      const [{ sent_at }] = await query<{ sent_at: Date }>(
        `SELECT sent_at FROM outbox WHERE org_id = $1 AND status = 'sent'`,
        [ORG]
      );
      const atraso = await atrasoDeAgrupamento(FONE, "deal-agr-1", "B");
      expect(atraso?.getTime()).toBe(sent_at.getTime() + DEZ_MIN);
    });

    it("irmão enviado há 11 min: null", async () => {
      await irmaoEnviado(AVISO_A, 11);
      expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", "A")).toBeNull();
    });

    it("com vários irmãos, vale o mais recente", async () => {
      await irmaoEnviado(AVISO_A, 8);
      await irmaoEnviado(AVISO_A, 2);
      const [{ ultimo }] = await query<{ ultimo: Date }>(
        `SELECT max(sent_at) AS ultimo FROM outbox WHERE org_id = $1`,
        [ORG]
      );
      const atraso = await atrasoDeAgrupamento(FONE, "deal-agr-1", "A");
      expect(atraso?.getTime()).toBe(ultimo.getTime() + DEZ_MIN);
    });

    it("nível C, sem chave ou sem nível: null, mesmo com irmão recente", async () => {
      await irmaoEnviado(AVISO_A, 1);
      expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", "C")).toBeNull();
      expect(await atrasoDeAgrupamento(FONE, null, "A")).toBeNull();
      expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", null)).toBeNull();
    });

    it("outro telefone, outro negócio e deal_party não contam como irmão", async () => {
      await irmaoEnviado(AVISO_A, 1, { phone: FONE2 });
      await irmaoEnviado(AVISO_A, 1, { dealId: "deal-agr-2" });
      await irmaoEnviado(AVISO_A, 1, { audience: "deal_party" });
      expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", "A")).toBeNull();
    });

    it("banco falhando não impede o envio: null", async () => {
      const db = await import("../db");
      const spy = vi.spyOn(db, "query").mockRejectedValueOnce(new Error("db fora"));
      const erro = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await atrasoDeAgrupamento(FONE, "deal-agr-1", "A")).toBeNull();
      } finally {
        spy.mockRestore();
        erro.mockRestore();
      }
    });
  });

  describe("enqueue", () => {
    it("o 1º aviso do negócio sai na hora (sem atraso)", async () => {
      const r = await enfileirar(AVISO_A);
      expect(Math.abs(r.deliverAfter.getTime() - nextDeliveryTime().getTime())).toBeLessThan(5_000);
    });

    it("com irmão enviado há 5 min: espera até sent_at + 10 min (e o 3º também)", async () => {
      await irmaoEnviado(AVISO_A, 5);
      const [{ sent_at }] = await query<{ sent_at: Date }>(`SELECT sent_at FROM outbox WHERE org_id = $1`, [ORG]);
      const esperado = nextDeliveryTime(new Date(sent_at.getTime() + DEZ_MIN));

      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      const a3 = await enfileirar(aviso(AVISO_A, "Três"));
      expect(a2.deliverAfter.getTime()).toBe(esperado.getTime());
      expect(a3.deliverAfter.getTime()).toBe(esperado.getTime());
      // gravado na linha, para o dispatchDue seguinte enxergar
      expect((await linha(a2.id)).deliver_after.getTime()).toBe(esperado.getTime());
    });

    it("nunca atrasa além de sent_at + 10 min (dentro da janela 7h-22h)", async () => {
      await irmaoEnviado(AVISO_A, 5);
      const [{ sent_at }] = await query<{ sent_at: Date }>(`SELECT sent_at FROM outbox WHERE org_id = $1`, [ORG]);
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      // fora da janela 7h-22h a abertura da janela manda; dentro, é sent + 10 exatos
      expect(a2.deliverAfter.getTime()).toBeLessThanOrEqual(
        Math.max(sent_at.getTime() + DEZ_MIN, nextDeliveryTime().getTime())
      );
    });

    it("marco C no meio: sai na hora e não ganha chave de grupo", async () => {
      await irmaoEnviado(AVISO_A, 2);
      const c = await enfileirar(AVISO_C);
      expect(Math.abs(c.deliverAfter.getTime() - nextDeliveryTime().getTime())).toBeLessThan(5_000);
      expect((await linha(c.id)).group_key).toBeNull();
    });

    it("deal_party nunca espera por irmão", async () => {
      await irmaoEnviado(AVISO_A, 2);
      const p = await enfileirar(AVISO_A, { audience: "deal_party" });
      expect(Math.abs(p.deliverAfter.getTime() - nextDeliveryTime().getTime())).toBeLessThan(5_000);
    });

    it("deliverAfter explícito (me lembra amanhã) continua valendo", async () => {
      await irmaoEnviado(AVISO_A, 2);
      const amanha = new Date(Date.now() + 20 * 3_600_000);
      const r = await enfileirar(AVISO_A, { deliverAfter: amanha });
      expect(r.deliverAfter.getTime()).toBe(amanha.getTime());
    });
  });

  describe("dispatchDue", () => {
    it("2º e 3º retidos: antes dos 10 min não saem; depois saem como UMA mensagem com botão abrir", async () => {
      const a1 = await enfileirar(aviso(AVISO_A, "Primeiro"));
      await vencer(a1.id);
      await dispatchDue();
      expect(saidas()).toHaveLength(1);
      expect(saidas()[0].texto).toContain("*Primeiro*"); // saiu como aviso normal, sozinho
      vi.clearAllMocks();
      sendText.mockResolvedValue({ messageId: "MID-T" });
      sendInteractive.mockResolvedValue({ messageId: "MID-I" });

      const a2 = await enfileirar(aviso(AVISO_A, "Segundo"));
      const a3 = await enfileirar(aviso(AVISO_B, "Terceiro"));

      // o dispatchDue seguinte, ainda dentro dos 10 min, não toca nas retidas
      await dispatchDue();
      expect(saidas()).toHaveLength(0);
      expect((await linha(a2.id)).status).toBe("pending");
      expect((await linha(a3.id)).status).toBe("pending");

      // passaram os 10 min: o prazo das retidas chega
      await query(`UPDATE outbox SET sent_at = sent_at - interval '11 minutes' WHERE id = $1`, [a1.id]);
      await vencer(a2.id, a3.id);
      const totals = await dispatchDue();

      const s = saidas();
      expect(s).toHaveLength(1);
      expect(s[0].via).toBe("interativo");
      expect(s[0].interativo?.tipo).toBe("botoes");
      expect(s[0].interativo?.opcoes).toEqual([{ id: `av:${a2.id}:abrir`, titulo: "🔗 Abrir negócio" }]);
      expect(s[0].texto).toContain("📌 *Venda Apto 302* andou bastante agora:");
      expect(s[0].texto).toContain("• 📌 Segundo");
      expect(s[0].texto).toContain("• ⏳ Terceiro");
      expect(s[0].texto).toContain("_RE/MAX Trio_");
      // o link vem pelo botão: a linha 👉 sai do corpo interativo
      expect(s[0].texto).not.toContain("👉");
      expect(s[0].texto).not.toContain("Responda");
      expect(totals.sent).toBe(2);

      const r2 = await linha(a2.id);
      const r3 = await linha(a3.id);
      expect([r2.status, r3.status]).toEqual(["sent", "sent"]);
      expect(r2.provider_message_id).toBe("MID-I");
      expect(r3.provider_message_id).toBe("MID-I");
      expect(r2.last_error).toBeNull();
    });

    it("o botão aponta para a linha que tem 'abrir' quando a primeira não tem", async () => {
      await irmaoEnviado(AVISO_A, 5);
      const b = await enfileirar(AVISO_B); // reenviar_link · lembrar_amanha · ver_formulario
      const a = await enfileirar(aviso(AVISO_A, "Com abrir"));
      await vencer(b.id, a.id);
      await dispatchDue();
      const [s] = saidas();
      expect(s.interativo?.opcoes).toEqual([{ id: `av:${a.id}:abrir`, titulo: "🔗 Abrir negócio" }]);
    });

    it("só 1 retido: sai normal, com o texto do próprio aviso", async () => {
      await irmaoEnviado(AVISO_A, 5);
      const a2 = await enfileirar(aviso(AVISO_A, "Sozinho"));
      await vencer(a2.id);
      await dispatchDue();
      const s = saidas();
      expect(s).toHaveLength(1);
      expect(s[0].texto).toContain("Oi, Ana! 📌 *Sozinho*");
      expect(s[0].texto).not.toContain("andou bastante");
      expect((await linha(a2.id)).provider_message_id).toBe("MID-T");
    });

    it("marco C no meio sai sozinho, com a imagem, e fica fora do resumo", async () => {
      await irmaoEnviado(AVISO_A, 4);
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      const c = await enfileirar(AVISO_C);
      const a3 = await enfileirar(aviso(AVISO_A, "Três"));
      // C não espera: já está vencida; as outras duas chegam a vencer 10 min depois
      await vencer(a2.id, c.id, a3.id);
      await dispatchDue();

      const s = saidas();
      expect(s).toHaveLength(2);
      const marco = s.find((x) => x.interativo?.imagemUrl);
      const resumo = s.find((x) => x.texto.includes("andou bastante"));
      expect(marco?.texto).toContain("Contrato assinado");
      expect(marco?.texto).not.toContain("andou bastante");
      expect(resumo?.texto).toContain("• 📌 Dois");
      expect(resumo?.texto).toContain("• 📌 Três");
      expect(resumo?.texto).not.toContain("Contrato assinado");
      expect((await linha(c.id)).status).toBe("sent");
      expect((await linha(a2.id)).provider_message_id).toBe((await linha(a3.id)).provider_message_id);
    });

    it("telefones diferentes não se misturam", async () => {
      await irmaoEnviado(AVISO_A, 5);
      await irmaoEnviado(AVISO_A, 5, { phone: FONE2 });
      const a2 = await enfileirar(aviso(AVISO_A, "A-dois"));
      const a3 = await enfileirar(aviso(AVISO_A, "A-três"));
      const b2 = await enfileirar(aviso(AVISO_A, "B-dois"), { phone: FONE2 });
      await vencer(a2.id, a3.id, b2.id);
      await dispatchDue();

      const s = saidas();
      expect(s).toHaveLength(2);
      const doA = s.find((x) => x.to === FONE);
      const doB = s.find((x) => x.to === FONE2);
      expect(doA?.texto).toContain("andou bastante");
      expect(doA?.texto).toContain("A-dois");
      expect(doA?.texto).toContain("A-três");
      expect(doA?.texto).not.toContain("B-dois");
      expect(doB?.texto).not.toContain("andou bastante");
      expect(doB?.texto).toContain("*B-dois*");
    });

    it("negócios diferentes do mesmo telefone não se misturam", async () => {
      const a = await enfileirar(aviso(AVISO_A, "Negócio 1"), { dealId: "deal-agr-1" });
      const b = await enfileirar(aviso(AVISO_A, "Negócio 2"), { dealId: "deal-agr-2" });
      await vencer(a.id, b.id);
      await dispatchDue();
      const s = saidas();
      expect(s).toHaveLength(2);
      expect(s.every((x) => !x.texto.includes("andou bastante"))).toBe(true);
    });

    it("deal_party nunca entra em resumo, nem ganha botão", async () => {
      const p1 = await enfileirar(aviso(AVISO_A, "Parte 1"), { audience: "deal_party" });
      const p2 = await enfileirar(aviso(AVISO_A, "Parte 2"), { audience: "deal_party" });
      await vencer(p1.id, p2.id);
      await dispatchDue();
      expect(sendInteractive).not.toHaveBeenCalled();
      const s = saidas();
      expect(s).toHaveLength(2);
      expect(s.every((x) => x.via === "texto" && !x.texto.includes("andou bastante"))).toBe(true);
    });

    it("deal_party não se junta aos avisos do corretor no mesmo telefone e negócio", async () => {
      const u1 = await enfileirar(aviso(AVISO_A, "Interno 1"));
      const u2 = await enfileirar(aviso(AVISO_A, "Interno 2"));
      const p = await enfileirar(aviso(AVISO_A, "Da parte"), { audience: "deal_party" });
      await vencer(u1.id, u2.id, p.id);
      await dispatchDue();
      const s = saidas();
      expect(s).toHaveLength(2);
      const resumo = s.find((x) => x.texto.includes("andou bastante"));
      expect(resumo?.texto).not.toContain("Da parte");
    });

    it("janela de 24h fechada: NÃO agrupa; cada linha segue o caminho do template", async () => {
      await query(`DELETE FROM conversation_window WHERE phone = $1`, [FONE]);
      const b1 = await enfileirar(aviso(AVISO_B, "B um"));
      const b2 = await enfileirar(aviso(AVISO_B, "B dois"));
      await vencer(b1.id, b2.id);
      const totals = await dispatchDue();
      expect(saidas()).toHaveLength(0); // texto livre fora da janela seria rejeitado pela Meta
      expect(totals.sent).toBe(0);
      expect(totals.held).toBe(2);
      for (const id of [b1.id, b2.id]) {
        const r = await linha(id);
        expect(r.status).toBe("pending");
        expect(r.provider_message_id).toBeNull();
        expect(r.last_error).toMatch(/^template_pendente/);
      }
    });

    it("Newton (sem botões): resumo com a linha 👉 Abrir negócio e sem 'Responda:'", async () => {
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
        await query(`DELETE FROM conversation_window WHERE phone = $1`, [FONE]);
        const b1 = await enfileirar(aviso(AVISO_B, "B um"));
        const b2 = await enfileirar(aviso(AVISO_B, "B dois"));
        await vencer(b1.id, b2.id);
        await dispatchDue();

        expect(sendInteractive).not.toHaveBeenCalled();
        expect(sendText).not.toHaveBeenCalled();
        expect(corpos).toHaveLength(1);
        expect(corpos[0].body).toContain("📌 *Venda Apto 302* andou bastante agora:");
        expect(corpos[0].body).toContain("• ⏳ B um");
        expect(corpos[0].body).toContain("• ⏳ B dois");
        expect(corpos[0].body).toContain(`👉 Abrir negócio: ${LINK}`);
        expect(corpos[0].body).not.toContain("Responda");
        expect(Object.keys(corpos[0])).not.toContain("interactive");
        expect((await linha(b1.id)).provider_message_id).toBe("Z1");
        expect((await linha(b2.id)).provider_message_id).toBe("Z1");
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    });

    it("MAX_INTERACTIVE=off: o resumo vai em texto, com o link no texto", async () => {
      vi.stubEnv("MAX_INTERACTIVE", "off");
      try {
        const a1 = await enfileirar(aviso(AVISO_A, "Um"));
        const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
        await vencer(a1.id, a2.id);
        await dispatchDue();
        expect(sendInteractive).not.toHaveBeenCalled();
        const s = saidas();
        expect(s).toHaveLength(1);
        expect(s[0].texto).toContain("andou bastante");
        expect(s[0].texto).toContain(`👉 Abrir negócio: ${LINK}`);
        expect(s[0].texto).not.toContain("Responda");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("a Meta recusa a forma (400): cai no texto do resumo, com o link", async () => {
      sendInteractive.mockRejectedValueOnce(
        new MetaHttpError("/x/messages", 400, JSON.stringify({ error: { code: 100, message: "bad" } }))
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const a1 = await enfileirar(aviso(AVISO_A, "Um"));
        const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
        await vencer(a1.id, a2.id);
        await dispatchDue();
      } finally {
        warn.mockRestore();
      }
      expect(sendInteractive).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0][0].body).toContain(`👉 Abrir negócio: ${LINK}`);
      expect(sendText.mock.calls[0][0].body).toContain("andou bastante");
    });

    it("kill switch MAX_OUTBOUND_KILL: nada sai e as linhas continuam pendentes", async () => {
      const a1 = await enfileirar(aviso(AVISO_A, "Um"));
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      await vencer(a1.id, a2.id);
      vi.stubEnv("MAX_OUTBOUND_KILL", "true");
      try {
        const totals = await dispatchDue();
        expect(totals.claimed).toBe(0);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(saidas()).toHaveLength(0);
      expect((await linha(a1.id)).status).toBe("pending");
      expect((await linha(a2.id)).status).toBe("pending");
    });

    it("dispatch_fence: linha sem fence igual não entra no resumo (segue o caminho individual)", async () => {
      const a1 = await enfileirar(aviso(AVISO_A, "Um"));
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      const a3 = await enfileirar(aviso(AVISO_A, "Três"));
      await query(`UPDATE outbox SET dispatch_fence = NULL WHERE id = $1`, [a3.id]);
      await vencer(a1.id, a2.id, a3.id);
      await dispatchDue();
      const s = saidas();
      expect(s).toHaveLength(2);
      const resumo = s.find((x) => x.texto.includes("andou bastante"));
      expect(resumo?.texto).toContain("Um");
      expect(resumo?.texto).toContain("Dois");
      expect(resumo?.texto).not.toContain("Três");
      expect(s.find((x) => x.texto.includes("*Três*"))).toBeDefined();
    });

    it("falha no envio do resumo: nenhuma linha se perde; cada uma volta com backoff e sai sozinha depois", async () => {
      sendInteractive.mockRejectedValueOnce(new Error("boom"));
      const a1 = await enfileirar(aviso(AVISO_A, "Um"));
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      await vencer(a1.id, a2.id);
      const t1 = await dispatchDue();
      expect(t1.failed).toBe(2);
      expect(t1.sent).toBe(0);
      for (const id of [a1.id, a2.id]) {
        const r = await linha(id);
        expect(r.status).toBe("pending");
        expect(r.attempts).toBe(1);
        expect(r.last_error).toBe("boom");
        expect(r.send_started_at).toBeNull();
        expect(r.deliver_after.getTime()).toBeGreaterThan(Date.now());
        expect(r.group_key).toBe("deal-agr-1");
      }

      // volta a vencer: agora cada uma sai sozinha (1ª tentativa já foi do resumo)
      vi.clearAllMocks();
      sendText.mockResolvedValue({ messageId: "MID-T" });
      await vencer(a1.id, a2.id);
      const t2 = await dispatchDue();
      expect(t2.sent).toBe(2);
      const s = saidas();
      expect(s).toHaveLength(2);
      expect(s.every((x) => !x.texto.includes("andou bastante"))).toBe(true);
    });

    it("resumo enviado semeia o thread uma vez, com o texto do resumo", async () => {
      const mod = await import("../identity");
      (mod.resolveIdentity as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        kind: "resolved",
        candidate: { orgId: ORG, kind: "user", userId: "u1" },
      });
      const a1 = await enfileirar(aviso(AVISO_A, "Um"));
      const a2 = await enfileirar(aviso(AVISO_A, "Dois"));
      await vencer(a1.id, a2.id);
      await dispatchDue();
      expect(seedNotification).toHaveBeenCalledTimes(1);
      expect(seedNotification.mock.calls[0][2]).toContain("andou bastante");
    });

    it("duas instâncias concorrentes: cada aviso sai uma vez só, dentro OU fora do resumo", async () => {
      for (let volta = 0; volta < 3; volta++) {
        vi.clearAllMocks();
        let n = 0;
        sendText.mockImplementation(async () => ({ messageId: `MT-${++n}` }));
        sendInteractive.mockImplementation(async () => ({ messageId: `MI-${++n}` }));
        await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);

        const t = [`Alfa${volta}`, `Beta${volta}`, `Gama${volta}`, `Delta${volta}`];
        const ids: string[] = [];
        for (const titulo of t) ids.push((await enfileirar(aviso(AVISO_A, titulo))).id);
        await vencer(...ids);

        await Promise.all([dispatchDue(), dispatchDue()]);

        const s = saidas();
        const todos = s.map((x) => x.texto).join("\n---\n");
        for (const titulo of t) {
          // cada título aparece em exatamente uma mensagem, uma vez
          expect(todos.split(titulo).length - 1).toBe(1);
        }
        const rows = await Promise.all(ids.map(linha));
        expect(rows.every((r) => r.status === "sent")).toBe(true);
        // cada mensagem enviada tem um id de provedor próprio e nenhuma linha ficou sem
        const pmids = new Set(rows.map((r) => r.provider_message_id));
        expect(pmids.size).toBe(s.length);
        expect(rows.every((r) => r.attempts === 1)).toBe(true);
      }
    });

    it("rajada grande: o resumo respeita 1500 e o corpo interativo 1024, e todas as linhas ficam sent", async () => {
      const longo = "T".repeat(100);
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) ids.push((await enfileirar(aviso(AVISO_A, `${i}-${longo}`))).id);
      await vencer(...ids);
      await dispatchDue();
      const s = saidas();
      expect(s).toHaveLength(1);
      expect(Array.from(s[0].texto).length).toBeLessThanOrEqual(1024);
      expect(s[0].texto).toMatch(/• …e mais \d+/);
      const rows = await Promise.all(ids.map(linha));
      expect(rows.every((r) => r.status === "sent")).toBe(true);
    });
  });
});
