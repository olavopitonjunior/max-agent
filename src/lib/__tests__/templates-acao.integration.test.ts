import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

/**
 * PR 3 (05/10/2026) contra o Postgres real: os templates de proposta
 * (`proposal_*`, `catalog.ts`) e os botões de AÇÃO.
 *
 *  - `dispatchDue` só usa um template com `paramsObrigatorios` quando a linha
 *    TEM o parâmetro (nunca com fallback) — ver `outbox.ts`.
 *  - os botões de ação saem no envio com o payload `acao:<id>:<ação>`
 *    (`botoesDaLinha`), na MESMA ordem da submissão (`botoesEmOrdem`).
 *  - o clique no botão (`lib/aceite.ts`) valida linha, telefone, kind e
 *    janela antes de responder com o texto fixo.
 *
 * Arquivo PRÓPRIO (não `outbox.integration.test.ts` nem
 * `aceite.integration.test.ts`) — instrução do PR 3.
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
  sendText: vi.fn().mockResolvedValue({ messageId: "wamid.MID" }),
  sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.TPL" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));
vi.mock("../zapi", async (orig) => ({
  ...(await orig<typeof import("../zapi")>()),
  sendText: vi.fn().mockResolvedValue({ messageId: "ZMID" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue, botoesDaLinha, marcaParametroAusente } = await import("../outbox");
const { interceptar } = await import("../aceite");
const { CATALOGO } = await import("../templates/catalog");
const { query } = await import("../db");
const meta = await import("../meta");
import type { InboundMessage } from "../transport";

const PHONE = "5511900771122";
const OUTRO = "5511900773344";
const ORG = "org-templates-acao";
const metaSendTemplate = meta.sendTemplate as unknown as ReturnType<typeof vi.fn>;

async function linha(
  dedupeKey: string,
  kind: string,
  params: Record<string, string> | null,
  extra: Partial<Parameters<typeof enqueue>[0]> = {}
) {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey,
    audience: "platform_user",
    phone: PHONE,
    recipientName: "Carlos Souza",
    title: "Proposta",
    body: "corpo",
    linkUrl: "https://imobpro.ia.br/propostas/42",
    dealId: null,
    orgName: "RE/MAX Trio",
    kind,
    params,
    ...extra,
  });
  if (r.status !== "queued") throw new Error("duplicata no setup");
  await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE id = $1`, [r.id]);
  return r.id;
}

async function aprovar(...names: string[]) {
  for (const name of names) {
    await query(
      `INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')
       ON CONFLICT (name) DO UPDATE SET status = 'APPROVED'`,
      [name]
    );
  }
}

async function estado(dedupeKey: string) {
  const [l] = await query<{
    status: string;
    last_error: string | null;
    template_name: string | null;
  }>(`SELECT status, last_error, template_name FROM outbox WHERE dedupe_key = $1`, [dedupeKey]);
  return l;
}

let seq = 0;
function msg(p: Partial<InboundMessage>): InboundMessage {
  seq += 1;
  return {
    messageId: `wamid.ACAO.${Date.now()}.${seq}`,
    fromPhone: PHONE,
    groupId: null,
    kind: "text",
    text: null,
    mediaUrl: null,
    mimeType: null,
    timestampMs: Date.now(),
    senderName: "Carlos",
    replyToMessageId: null,
    buttonPayload: null,
    ...p,
  };
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [
    [
      "max_proposta_assinada",
      "max_proposta_recusada",
      "max_proposta_expirada",
      "max_proposta_entregue",
    ],
  ]);
  await query(`DELETE FROM conversation_window WHERE phone = ANY($1)`, [[PHONE, OUTRO]]);
  // A "regressão" abre um repasse de verdade (`pending_handoff`) — sem
  // limpar, a linha sobrevive ao arquivo e contamina uma rodada seguinte
  // (achado ao rodar a mutação de controle do item 3).
  await query(`DELETE FROM pending_handoff WHERE phone = ANY($1)`, [[PHONE, OUTRO]]);
}

d("parâmetro obrigatório + botões de ação (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    metaSendTemplate.mockResolvedValue({ messageId: "wamid.TPL" });
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    await limpar();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(limpar);

  describe("parâmetro obrigatório ausente — não sai por template", () => {
    it("proposal_completed SEM `proposta`: falha com `parametro_ausente`, nunca chama a Meta", async () => {
      await aprovar("max_proposta_assinada");
      await linha("pa-sem-proposta", "proposal_completed", null);

      const totals = await dispatchDue();

      expect(metaSendTemplate).not.toHaveBeenCalled();
      expect(totals.failed).toBe(1);
      expect(totals.sent).toBe(0);
      const l = await estado("pa-sem-proposta");
      expect(l.status).toBe("failed");
      expect(l.last_error).toBe(marcaParametroAusente("proposta"));
      expect(l.template_name).toBeNull();
    });

    it("`proposta` em branco conta como ausente", async () => {
      await aprovar("max_proposta_assinada");
      await linha("pa-proposta-vazia", "proposal_completed", { proposta: "   " });

      await dispatchDue();

      const l = await estado("pa-proposta-vazia");
      expect(l.status).toBe("failed");
      expect(l.last_error).toBe(marcaParametroAusente("proposta"));
    });

    it("proposal_refused SEM `quem` (só `proposta`): também falha, nunca com fallback", async () => {
      await aprovar("max_proposta_recusada");
      await linha("pa-sem-quem", "proposal_refused", { proposta: "PROP-0042" });

      await dispatchDue();

      expect(metaSendTemplate).not.toHaveBeenCalled();
      const l = await estado("pa-sem-quem");
      expect(l.status).toBe("failed");
      expect(l.last_error).toBe(marcaParametroAusente("quem"));
    });

    /** Nunca é `fora_da_regua`: o kind TEM template — falta é o parâmetro. */
    it("a marca é PRÓPRIA — não se confunde com fora_da_regua", async () => {
      await aprovar("max_proposta_assinada");
      await linha("pa-marca", "proposal_completed", null);
      await dispatchDue();
      const l = await estado("pa-marca");
      expect(l.last_error).not.toContain("fora_da_regua");
      expect(l.last_error).toContain("parametro_ausente");
    });
  });

  describe("parâmetro obrigatório presente — sai com os valores certos", () => {
    it("proposal_completed COM `proposta`: sai por template, body e botões de ação certos", async () => {
      await aprovar("max_proposta_assinada");
      const id = await linha("pa-com-proposta", "proposal_completed", {
        proposta: "PROP-0042 Apto Rua das Flores",
      });

      const totals = await dispatchDue();

      expect(totals.sent).toBe(1);
      expect(metaSendTemplate).toHaveBeenCalledTimes(1);
      const chamada = metaSendTemplate.mock.calls[0][0];
      expect(chamada.name).toBe("max_proposta_assinada");
      expect(chamada.bodyParams).toEqual(["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"]);
      expect(chamada.botoes).toEqual([
        { tipo: "quick_reply", payload: `acao:${id}:converter` },
        { tipo: "quick_reply", payload: `acao:${id}:agora_nao` },
      ]);
      const l = await estado("pa-com-proposta");
      expect(l.status).toBe("sent");
      expect(l.template_name).toBe("max_proposta_assinada");
    });

    it("proposal_refused COM `proposta` e `quem`: body com os 4 parâmetros, botão ação+url", async () => {
      await aprovar("max_proposta_recusada");
      const id = await linha("pa-refused-completo", "proposal_refused", {
        proposta: "PROP-0042 Apto Rua das Flores",
        quem: "pelo proprietário",
      });

      const totals = await dispatchDue();

      expect(totals.sent).toBe(1);
      const chamada = metaSendTemplate.mock.calls[0][0];
      expect(chamada.name).toBe("max_proposta_recusada");
      expect(chamada.bodyParams).toEqual([
        "Carlos",
        "PROP-0042 Apto Rua das Flores",
        "RE/MAX Trio",
        "pelo proprietário",
      ]);
      expect(chamada.botoes).toEqual([
        { tipo: "url", param: id },
        { tipo: "quick_reply", payload: `acao:${id}:recriar` },
      ]);
    });

    it("botoesDaLinha e o que a Meta recebe (botoesEmOrdem) usam a mesma ordem", async () => {
      await aprovar("max_proposta_entregue");
      const id = await linha("pa-entregue", "proposal_delivered", {
        proposta: "PROP-0042 Apto Rua das Flores",
        quem: "ao proprietário",
      });
      await dispatchDue();
      expect(botoesDaLinha(CATALOGO.proposal_delivered, id)).toEqual([{ tipo: "url", param: id }]);
      expect(metaSendTemplate.mock.calls[0][0].botoes).toEqual([{ tipo: "url", param: id }]);
    });
  });

  describe("clique no botão de ação (lib/aceite.ts)", () => {
    async function enviada(dedupeKey: string, kind: string, phone = PHONE) {
      const id = await linha(dedupeKey, kind, { proposta: "PROP-1", quem: "pelo proprietário" }, { phone });
      await query(
        `UPDATE outbox SET status = 'sent', template_name = $2, sent_at = now()
          WHERE id = $1`,
        [id, CATALOGO[kind as keyof typeof CATALOGO].name]
      );
      return id;
    }

    it("converter válido: responde com o link absoluto da linha", async () => {
      const id = await enviada("ac-converter", "proposal_completed");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:converter` }));
      expect(r).toEqual({
        reply: "Para converter a proposta em negócio, abra a proposta pelo link: https://imobpro.ia.br/propostas/42",
        orgId: ORG,
        marca: "acao_converter_pendente",
      });
    });

    it("link fora do domínio do ImobPro (ou nulo) não vai na resposta", async () => {
      const id = await enviada("ac-link-estranho", "proposal_refused");
      await query(`UPDATE outbox SET link_url = 'https://evil.example/x' WHERE id = $1`, [id]);
      const r1 = await interceptar(msg({ buttonPayload: `acao:${id}:recriar` }));
      expect(r1?.reply).toBe("Para recriar a proposta, abra a proposta no ImobPro.");
      await query(`UPDATE outbox SET link_url = NULL WHERE id = $1`, [id]);
      const r2 = await interceptar(msg({ buttonPayload: `acao:${id}:recriar` }));
      expect(r2?.reply).toBe("Para recriar a proposta, abra a proposta no ImobPro.");
    });

    it("agora_nao válido: texto fixo, sem link", async () => {
      const id = await enviada("ac-agora-nao", "proposal_completed");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:agora_nao` }));
      expect(r).toEqual({
        reply: "Tudo bem. A proposta continua no sistema.",
        orgId: ORG,
        marca: "acao_agora_nao_pendente",
      });
    });

    it("recriar válido (proposal_refused)", async () => {
      const id = await enviada("ac-recriar", "proposal_refused");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:recriar` }));
      expect(r?.marca).toBe("acao_recriar_pendente");
      expect(r?.reply).toContain("recriar a proposta");
    });

    it("recriar também vale para proposal_expired", async () => {
      const id = await enviada("ac-recriar-exp", "proposal_expired");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:recriar` }));
      expect(r?.marca).toBe("acao_recriar_pendente");
    });

    it("id inexistente: resposta neutra", async () => {
      const r = await interceptar(msg({ buttonPayload: "acao:00000000-0000-0000-0000-000000000000:converter" }));
      expect(r).toEqual({
        reply: "Esse botão não está mais disponível.",
        orgId: null,
        marca: "acao_sem_pendencia",
      });
    });

    it("linha de OUTRO telefone: resposta neutra, não entrega o link de ninguém", async () => {
      const id = await enviada("ac-outro-fone", "proposal_completed", OUTRO);
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:converter`, fromPhone: PHONE }));
      expect(r?.marca).toBe("acao_sem_pendencia");
    });

    it("kind incompatível: converter só vale em proposal_completed", async () => {
      const id = await enviada("ac-kind-errado", "proposal_refused");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:converter` }));
      expect(r?.marca).toBe("acao_sem_pendencia");
    });

    it("kind incompatível: recriar não vale em proposal_completed", async () => {
      const id = await enviada("ac-kind-errado-2", "proposal_completed");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:recriar` }));
      expect(r?.marca).toBe("acao_sem_pendencia");
    });

    it("janela vencida (> 7 dias): resposta neutra", async () => {
      const id = await enviada("ac-vencida", "proposal_completed");
      await query(`UPDATE outbox SET sent_at = now() - interval '8 days' WHERE id = $1`, [id]);
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:converter` }));
      expect(r?.marca).toBe("acao_sem_pendencia");
    });

    it("ação fora do enum: ignora (payload desconhecido), não responde neutro", async () => {
      const id = await enviada("ac-fora-enum", "proposal_completed");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}:apagar_tudo`, text: "Converter em negócio" }));
      expect(r).toBeNull();
    });

    it("payload malformado (sem a ação): ignora", async () => {
      const id = await enviada("ac-malformado", "proposal_completed");
      const r = await interceptar(msg({ buttonPayload: `acao:${id}` }));
      expect(r).toBeNull();
    });

    it("idempotente: a reentrega do mesmo clique responde igual", async () => {
      const id = await enviada("ac-idempotente", "proposal_completed");
      const m = msg({ buttonPayload: `acao:${id}:converter` });
      const r1 = await interceptar(m);
      const r2 = await interceptar(m);
      expect(r1).toEqual(r2);
    });
  });

  describe("regressão: ok/dúvida continuam funcionando com o novo ramo de ação", () => {
    it("OK ainda entrega mensagem guardada", async () => {
      const id = await linha("reg-ok", "manual_message", null, { body: "Oi, confirma a visita?" });
      await query(
        `UPDATE outbox SET status = 'sent', template_name = 'max_mensagem_imobiliaria', sent_at = now()
          WHERE id = $1`,
        [id]
      );
      const r = await interceptar(msg({ buttonPayload: `ok:${id}` }));
      expect(r?.marca).toBe("aceite_entregue");
    });

    it("dúvida ainda abre o repasse", async () => {
      const id = await linha("reg-duvida", "onboarding_pending", null);
      await query(
        `UPDATE outbox SET status = 'sent', template_name = 'max_configuracao_pendente', sent_at = now()
          WHERE id = $1`,
        [id]
      );
      const r = await interceptar(msg({ buttonPayload: `duvida:${id}`, text: "Tenho uma dúvida" }));
      expect(r?.marca).toBe("duvida_aberta");
    });
  });
});
