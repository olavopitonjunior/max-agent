import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

/**
 * O aceite contra o Postgres real: a trava do `released_at` (OK repetido não
 * duplica), o filtro de "saiu por template para ESTE telefone" e o repasse
 * de dúvida com o pedido consumido numa consulta só.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { interceptar, ehOk, ehPedidoDeDuvida, repassarDesconhecido } = await import("../aceite");
const { SEM_ORG } = await import("../sem-org");
const { enqueue } = await import("../outbox");
const { query } = await import("../db");
import type { InboundMessage } from "../transport";

const ORG = "org-aceite";
const PHONE = "5511900002222";
const OUTRO = "5511900003333";
const TIME = "5511900009999";

let seq = 0;
function msg(p: Partial<InboundMessage>): InboundMessage {
  seq += 1;
  return {
    messageId: `wamid.ACEITE.${Date.now()}.${seq}`,
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

/** Uma linha como o dispatch a deixa depois de sair: `sent`, com ou sem template. */
async function enviada(
  dedupeKey: string,
  o: { kind: string; body?: string; phone?: string; template?: string | null; diasAtras?: number }
): Promise<string> {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey,
    audience: "deal_party",
    phone: o.phone ?? PHONE,
    recipientName: "Carlos Souza",
    title: "Mensagem da imobiliária",
    body: o.body ?? "Traga o RG original na vistoria de quinta.",
    linkUrl: null,
    dealId: null,
    orgName: "RE/MAX Trio",
    kind: o.kind,
  });
  if (r.status !== "queued") throw new Error("duplicata no setup");
  await query(
    `UPDATE outbox SET status = 'sent', template_name = $2,
            sent_at = now() - ($3 || ' days')::interval
      WHERE id = $1`,
    [r.id, o.template === undefined ? "max_mensagem_imobiliaria" : o.template, String(o.diasAtras ?? 0)]
  );
  return r.id;
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  await query(`DELETE FROM pending_handoff WHERE phone = ANY($1)`, [[PHONE, OUTRO]]);
  await query(`DELETE FROM conversation_turn WHERE phone = ANY($1)`, [[PHONE, OUTRO, TIME]]);
}

describe("reconhecimento do texto", () => {
  it("OK é só OK", () => {
    for (const t of ["ok", "OK", " Ok! ", "ok.", "okay"]) expect(ehOk(t), t).toBe(true);
    for (const t of ["ok, mas e o contrato?", "não ok", "okk", "", "tá ok"]) expect(ehOk(t), t).toBe(false);
  });
  it("a frase do botão de dúvida, digitada", () => {
    expect(ehPedidoDeDuvida("Tenho uma dúvida")).toBe(true);
    expect(ehPedidoDeDuvida("tenho uma duvida!")).toBe(true);
    expect(ehPedidoDeDuvida("tenho uma dúvida sobre o contrato")).toBe(false);
  });
});

d("aceite (Postgres real)", () => {
  beforeEach(async () => {
    await limpar();
    vi.stubEnv("MAX_ESCALATION_PHONE", `+${TIME}`);
    vi.stubEnv("MAX_ESCALATION_NAME", "Olavo");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(limpar);

  describe("mensagem da imobiliária", () => {
    it("toque no OK entrega o texto guardado daquela linha, com a assinatura da imobiliária", async () => {
      const id = await enviada("a-botao", { kind: "manual_message_parte" });
      const r = await interceptar(msg({ text: "OK", buttonPayload: `ok:${id}` }));
      expect(r).toEqual({
        reply: "*Mensagem da RE/MAX Trio*\n\nTraga o RG original na vistoria de quinta.",
        orgId: ORG,
        marca: "aceite_entregue",
      });
      const [l] = await query<{ released_at: Date | null }>(`SELECT released_at FROM outbox WHERE id = $1`, [id]);
      expect(l.released_at).not.toBeNull();
    });

    it("OK repetido (ou reentrega do webhook) não entrega de novo", async () => {
      const id = await enviada("a-dup", { kind: "manual_message" });
      await interceptar(msg({ buttonPayload: `ok:${id}` }));
      const r2 = await interceptar(msg({ buttonPayload: `ok:${id}` }));
      expect(r2?.marca).toBe("aceite_sem_pendencia");
      // Digitado, sem nada guardado: "ok" é conversa — segue para o grafo.
      expect(await interceptar(msg({ text: "ok" }))).toBeNull();
    });

    it("OK digitado entrega TODAS as pendentes deste telefone, e só deste", async () => {
      await enviada("a-t1", { kind: "manual_message", body: "Primeira." });
      await enviada("a-t2", { kind: "manual_message_parte", body: "Segunda." });
      await enviada("a-outro", { kind: "manual_message", body: "De outro.", phone: OUTRO });
      const r = await interceptar(msg({ text: "Ok!" }));
      expect(r?.marca).toBe("aceite_entregue");
      expect(r?.reply).toContain("Primeira.");
      expect(r?.reply).toContain("Segunda.");
      expect(r?.reply).not.toContain("De outro.");
    });

    it("payload com id de OUTRO telefone não entrega nada", async () => {
      const id = await enviada("a-alheio", { kind: "manual_message", phone: OUTRO });
      const r = await interceptar(msg({ buttonPayload: `ok:${id}` }));
      expect(r?.marca).toBe("aceite_sem_pendencia");
    });

    it("o que saiu como texto livre (dentro da janela) já foi entregue — OK não repete", async () => {
      await enviada("a-livre", { kind: "manual_message", template: null });
      expect(await interceptar(msg({ text: "ok" }))).toBeNull();
    });

    it("tipo sem aceite (ex.: contrato assinado) nunca é entregue pelo OK", async () => {
      await enviada("a-outro-kind", { kind: "contract_signed", template: "max_contrato_assinado" });
      expect(await interceptar(msg({ text: "ok" }))).toBeNull();
    });

    /**
     * O turn pode morrer DEPOIS de liberar e antes de a resposta sair: a
     * retentativa da MESMA mensagem tem de reencontrar o texto (achado do
     * code review — antes, a linha ficava marcada como entregue e o texto
     * se perdia).
     */
    it("retentativa da mesma mensagem entrega de novo; outra mensagem, não", async () => {
      const id = await enviada("a-retry", { kind: "manual_message" });
      const m = msg({ buttonPayload: `ok:${id}` });
      expect((await interceptar(m))?.marca).toBe("aceite_entregue");
      expect((await interceptar(m))?.marca).toBe("aceite_entregue");
      expect((await interceptar(msg({ buttonPayload: `ok:${id}` })))?.marca).toBe("aceite_sem_pendencia");
    });

    /**
     * "ok" depois de uma conversa com o modelo responde ao Max (confirmação
     * de ação), não ao template de dias atrás. O botão continua valendo.
     */
    it("OK digitado depois de conversa com o modelo não rouba a confirmação; o botão ainda entrega", async () => {
      const id = await enviada("a-conversa", { kind: "manual_message", diasAtras: 1 });
      await query(
        `INSERT INTO conversation_turn (org_id, phone, message_id, inbound_text, reply_text, usage_json)
         VALUES ($1, $2, 'wamid.ANTES', 'cria um formulário', 'Confirma?', '[{"model":"m"}]')`,
        [ORG, PHONE]
      );
      expect(await interceptar(msg({ text: "ok" }))).toBeNull();
      expect((await interceptar(msg({ buttonPayload: `ok:${id}` })))?.marca).toBe("aceite_entregue");
    });

    it("turn que NÃO passou pelo modelo (ex.: saudação a desconhecido) não bloqueia o OK digitado", async () => {
      await enviada("a-saudacao", { kind: "manual_message_parte", diasAtras: 1 });
      await query(
        `INSERT INTO conversation_turn (org_id, phone, message_id, inbound_text, reply_text)
         VALUES ('(sem org)', $1, 'wamid.OI', 'quem é?', 'Oi! Eu sou o Max…')`,
        [PHONE]
      );
      expect((await interceptar(msg({ text: "ok" })))?.marca).toBe("aceite_entregue");
    });

    it("o que não cabe numa resposta fica para o próximo OK, e a pessoa é avisada", async () => {
      await enviada("a-longa1", { kind: "manual_message", body: "A".repeat(3000) });
      await enviada("a-longa2", { kind: "manual_message", body: "B".repeat(3000) });
      const r1 = await interceptar(msg({ text: "ok" }));
      expect(r1?.reply).toContain("A".repeat(3000));
      expect(r1?.reply).not.toContain("BBB");
      expect(r1?.reply).toContain("Há mais uma mensagem");
      const r2 = await interceptar(msg({ text: "ok" }));
      expect(r2?.reply).toContain("B".repeat(3000));
      expect(r2?.reply).not.toContain("Há mais");
    });

    it("depois de 7 dias o OK não entrega mais", async () => {
      await enviada("a-velha", { kind: "manual_message", diasAtras: 8 });
      expect(await interceptar(msg({ text: "ok" }))).toBeNull();
    });
  });

  describe("dúvida de configuração", () => {
    async function lembrete(diasAtras = 0) {
      return enviada("d-lembrete", {
        kind: "onboarding_pending",
        template: "max_configuracao_pendente",
        diasAtras,
      });
    }

    async function repasses() {
      return query<{ phone: string; kind: string; body: string; params: Record<string, string> }>(
        `SELECT phone, kind, body, params FROM outbox WHERE org_id = $1 AND kind = 'support_handoff'`,
        [ORG]
      );
    }

    it("toque em 'Tenho uma dúvida' → próxima mensagem vai para o time como support_handoff", async () => {
      const id = await lembrete();
      const aberto = await interceptar(msg({ text: "Tenho uma dúvida", buttonPayload: `duvida:${id}` }));
      expect(aberto?.marca).toBe("duvida_aberta");

      const duvida = msg({ text: "Como cadastro meus corretores?" });
      const r = await interceptar(duvida);
      expect(r?.marca).toBe("duvida_repassada");

      const [h] = await repasses();
      expect(h.phone).toBe(TIME);
      expect(h.body).toContain("Como cadastro meus corretores?");
      expect(h.body).toContain(`+${PHONE}`);
      expect(h.body).toContain("RE/MAX Trio");
      expect(h.params).toEqual({ quem: "Carlos Souza", de: PHONE });

      // Retentativa da MESMA mensagem: reencontra o pedido, responde igual e
      // não repassa de novo (dedupe pela wamid).
      expect((await interceptar(duvida))?.marca).toBe("duvida_repassada");
      expect(await repasses()).toHaveLength(1);
      // Consumido: a mensagem seguinte é conversa normal.
      expect(await interceptar(msg({ text: "obrigado" }))).toBeNull();
    });

    it("a frase digitada também abre o repasse — e não vira ela mesma a dúvida", async () => {
      await lembrete();
      const r = await interceptar(msg({ text: "tenho uma dúvida" }));
      expect(r?.marca).toBe("duvida_aberta");
      expect(await repasses()).toHaveLength(0);
    });

    it("sem lembrete recente, a frase é conversa normal", async () => {
      await lembrete(4);
      expect(await interceptar(msg({ text: "tenho uma dúvida" }))).toBeNull();
      expect(await interceptar(msg({ text: "Tenho uma dúvida", buttonPayload: "duvida:x" }))).toBeNull();
    });

    it("pedido vencido não captura a mensagem — e some", async () => {
      await query(
        `INSERT INTO pending_handoff (phone, org_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')`,
        [PHONE, ORG]
      );
      expect(await interceptar(msg({ text: "e aí?" }))).toBeNull();
      const [{ n }] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pending_handoff WHERE phone = $1`,
        [PHONE]
      );
      expect(n).toBe(0);
    });

    it("sem MAX_ESCALATION_PHONE a pessoa é avisada e nada é enfileirado", async () => {
      vi.stubEnv("MAX_ESCALATION_PHONE", "");
      await query(
        `INSERT INTO pending_handoff (phone, org_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [PHONE, ORG]
      );
      const r = await interceptar(msg({ text: "minha dúvida" }));
      expect(r?.marca).toBe("duvida_sem_destino");
      expect(await repasses()).toHaveLength(0);
      // O pedido continua aberto: com o destino de volta, a nova tentativa vai.
      vi.stubEnv("MAX_ESCALATION_PHONE", `+${TIME}`);
      expect((await interceptar(msg({ text: "minha dúvida" })))?.marca).toBe("duvida_repassada");
    });

    it("no máximo 3 repasses por pessoa em 24h — cada um é template pago", async () => {
      await lembrete();
      for (let i = 0; i < 3; i++) {
        await interceptar(msg({ text: "tenho uma dúvida" }));
        expect((await interceptar(msg({ text: `dúvida ${i}` })))?.marca).toBe("duvida_repassada");
      }
      await interceptar(msg({ text: "tenho uma dúvida" }));
      expect((await interceptar(msg({ text: "dúvida 4" })))?.marca).toBe("duvida_teto");
      expect(await repasses()).toHaveLength(3);
      // O pedido foi consumido: a próxima é conversa normal.
      expect(await interceptar(msg({ text: "e agora?" }))).toBeNull();
    });

    it("o time responde OK e recebe a dúvida", async () => {
      await lembrete();
      await interceptar(msg({ text: "tenho uma dúvida" }));
      await interceptar(msg({ text: "Onde troco o logo?" }));
      await query(
        `UPDATE outbox SET status = 'sent', template_name = 'max_duvida_de_cliente', sent_at = now()
          WHERE org_id = $1 AND kind = 'support_handoff'`,
        [ORG]
      );
      const r = await interceptar(msg({ fromPhone: TIME, text: "ok" }));
      expect(r?.marca).toBe("aceite_entregue");
      expect(r?.reply).toContain("Onde troco o logo?");
    });
  });
});

d("apresentação do Max na primeira resposta (boas-vindas por template)", () => {
  beforeEach(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    await query(`DELETE FROM conversation_turn WHERE phone = $1`, [PHONE]);
  });
  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    await query(`DELETE FROM conversation_turn WHERE phone = $1`, [PHONE]);
  });

  const APRESENTACAO =
    "Olá, Ana! Eu sou o Max, o assistente da RE/MAX Trio no WhatsApp. Se quiser saber o que mais posso fazer, é só perguntar.";

  it("primeira mensagem depois das boas-vindas por template: o Max se apresenta — uma vez só", async () => {
    await enviada("ap-1", { kind: "welcome", template: "max_boas_vindas_v2", body: APRESENTACAO });
    const m1 = msg({ text: "oi" });
    expect(await interceptar(m1)).toEqual({ reply: APRESENTACAO, orgId: ORG, marca: "apresentacao_entregue" });
    // Retentativa da MESMA mensagem reencontra; a próxima segue para a conversa.
    expect((await interceptar(m1))?.marca).toBe("apresentacao_entregue");
    expect(await interceptar(msg({ text: "o que você faz?" }))).toBeNull();
  });

  it("boas-vindas que saíram como texto livre (janela aberta) já tinham a apresentação: nada a fazer", async () => {
    await enviada("ap-2", { kind: "welcome", template: null, body: APRESENTACAO });
    expect(await interceptar(msg({ text: "oi" }))).toBeNull();
  });

  it("boas-vindas pelo v1 (que já se apresenta) não repetem a apresentação", async () => {
    await enviada("ap-3", { kind: "welcome", template: "max_boas_vindas", body: APRESENTACAO });
    expect(await interceptar(msg({ text: "oi" }))).toBeNull();
  });

  it("quem já conversou depois das boas-vindas não recebe apresentação no meio da conversa", async () => {
    await enviada("ap-4", { kind: "welcome", template: "max_boas_vindas_v2", body: APRESENTACAO, diasAtras: 2 });
    await query(
      `INSERT INTO conversation_turn (org_id, phone, message_id, inbound_text, reply_text)
       VALUES ($1, $2, 'wamid.antes', '(áudio)', 'resposta')`,
      [ORG, PHONE]
    );
    expect(await interceptar(msg({ text: "oi" }))).toBeNull();
  });

  it("duas boas-vindas (convite reenviado): uma apresentação por pessoa, com a mais recente", async () => {
    await enviada("ap-5a", { kind: "welcome", template: "max_boas_vindas_v2", body: "antiga", diasAtras: 3 });
    await enviada("ap-5b", { kind: "welcome", template: "max_boas_vindas_v2", body: APRESENTACAO, diasAtras: 1 });
    expect((await interceptar(msg({ text: "oi" })))?.reply).toBe(APRESENTACAO);
    expect(await interceptar(msg({ text: "bom dia" }))).toBeNull();
  });

  it("pergunta de verdade como primeira mensagem segue para o grafo, e a apresentação é consumida", async () => {
    await enviada("ap-6", { kind: "welcome", template: "max_boas_vindas_v2", body: APRESENTACAO });
    expect(await interceptar(msg({ text: "como cadastro uma venda?" }))).toBeNull();
    expect(await interceptar(msg({ text: "oi" }))).toBeNull();
    const [row] = await query<{ released_at: Date | null }>(
      `SELECT released_at FROM outbox WHERE dedupe_key = 'ap-6'`
    );
    expect(row.released_at).not.toBeNull();
  });
});

/**
 * Número que nenhuma imobiliária reconhece e que insiste depois da
 * apresentação (decisão de 05/10/2026): a primeira insistência do dia vai para
 * a equipe; o resto do dia segue em silêncio.
 */
d("repasse de número sem cadastro", () => {
  const DESCONHECIDO = "5511900004444";

  async function repasses() {
    return query<{
      org_id: string;
      phone: string;
      kind: string;
      body: string;
      org_name: string;
      params: Record<string, string>;
    }>(
      `SELECT org_id, phone, kind, body, org_name, params FROM outbox
        WHERE kind = 'support_handoff' AND params->>'de' = $1`,
      [DESCONHECIDO]
    );
  }
  async function limparDesconhecido() {
    await query(`DELETE FROM outbox WHERE params->>'de' = $1 OR phone = $1`, [DESCONHECIDO]);
    await query(`DELETE FROM outbox WHERE params->>'de' IN ('5511900005555', $1)`, [TIME]);
  }

  beforeEach(async () => {
    vi.stubEnv("MAX_ESCALATION_PHONE", TIME);
    await limparDesconhecido();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(limparDesconhecido);

  it("primeira insistência vai para a equipe, com o texto e o número; a segunda do dia, não", async () => {
    const r1 = await repassarDesconhecido(
      msg({ fromPhone: DESCONHECIDO, senderName: "Luiz", text: "Quero falar com o Fabio, é esse número?" })
    );
    expect(r1?.marca).toBe("desconhecido_repassado");
    expect(r1?.reply).toContain("nossa equipe");
    const [linha] = await repasses();
    expect(linha.org_id).toBe(SEM_ORG);
    expect(linha.phone).toBe(TIME);
    expect(linha.body).toContain("Quero falar com o Fabio");
    expect(linha.body).toContain(DESCONHECIDO);
    expect(linha.org_name).toBe("imobiliária não identificada");
    expect(linha.params.quem).toBe("Luiz");

    const r2 = await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, text: "Consigo falar com ele?" }));
    expect(r2).toBeNull();
    expect(await repasses()).toHaveLength(1);
  });

  it("reentrega da MESMA mensagem repete a resposta sem enfileirar de novo", async () => {
    const m = msg({ fromPhone: DESCONHECIDO, text: "Oi, alguém aí?" });
    expect((await repassarDesconhecido(m))?.marca).toBe("desconhecido_repassado");
    expect((await repassarDesconhecido(m))?.marca).toBe("desconhecido_repassado");
    expect(await repasses()).toHaveLength(1);
  });

  it("depois de 24h, repassa de novo", async () => {
    await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, text: "primeira" }));
    await query(`UPDATE outbox SET created_at = now() - interval '25 hours' WHERE params->>'de' = $1`, [
      DESCONHECIDO,
    ]);
    expect((await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, text: "segunda" })))?.marca).toBe(
      "desconhecido_repassado"
    );
    expect(await repasses()).toHaveLength(2);
  });

  it("parte de negócio (recebeu aviso de uma org) é repassada com o nome dessa org", async () => {
    await enviada("parte-aviso", { kind: "form_reminder", phone: DESCONHECIDO });
    await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, text: "não consigo abrir o link" }));
    const linhas = await query<{ org_id: string; org_name: string; body: string }>(
      `SELECT org_id, org_name, body FROM outbox WHERE kind = 'support_handoff' AND params->>'de' = $1`,
      [DESCONHECIDO]
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0].org_id).toBe(ORG);
    expect(linhas[0].org_name).toBe("RE/MAX Trio");
    expect(linhas[0].body).toContain("recebeu aviso da RE/MAX Trio");
  });

  it("teto global: com 10 repasses de desconhecidos no dia, o 11º número fica em silêncio", async () => {
    for (let i = 0; i < 10; i++) {
      await enqueue({
        orgId: SEM_ORG,
        dedupeKey: `handoff:global-${i}-${Date.now()}`,
        audience: "platform_user",
        phone: TIME,
        recipientName: "equipe",
        title: "x",
        body: "x",
        linkUrl: null,
        dealId: null,
        orgName: "x",
        kind: "support_handoff",
        params: { quem: "x", de: DESCONHECIDO, desconhecido: "1" },
      });
    }
    expect(await repassarDesconhecido(msg({ fromPhone: "5511900005555", text: "oi" }))).toBeNull();
  });

  it("o telefone da própria equipe não repassa para si mesmo", async () => {
    expect(await repassarDesconhecido(msg({ fromPhone: TIME, text: "teste" }))).toBeNull();
  });

  it("sem texto (áudio, figurinha) ou sem MAX_ESCALATION_PHONE: silêncio, nada enfileirado", async () => {
    expect(await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, kind: "audio", text: null }))).toBeNull();
    vi.stubEnv("MAX_ESCALATION_PHONE", "");
    expect(await repassarDesconhecido(msg({ fromPhone: DESCONHECIDO, text: "oi" }))).toBeNull();
    expect(await repasses()).toHaveLength(0);
  });
});
