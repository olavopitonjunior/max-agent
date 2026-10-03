import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * As métricas da régua contra o Postgres real: cada número sai de SQL, e o
 * que se prova aqui é que o SQL conta o que o goal diz — inclusive o que NÃO
 * deve contar (outra org, fora do período, imaturo, toque em botão).
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { metricasDoMax, metricasDoContractmaker, somenteLeitura } = await import("../metricas-regua");
const { query } = await import("../db");

const URL_TESTE = process.env.DATABASE_URL ?? "";
const ORG = "org-metricas";
const OUTRA = "org-metricas-outra";
const DESDE = new Date("2026-03-01T03:00:00Z");
const ATE = new Date("2026-04-01T03:00:00Z");
const DENTRO = "2026-03-10T15:00:00Z";

let seq = 0;
async function linha(o: {
  org?: string;
  kind: string | null;
  status?: string;
  entrega?: string | null;
  template?: string | null;
  phone?: string;
  criado?: string;
  enviado?: string | null;
  liberado?: string | null;
  erro?: number | null;
  lastError?: string | null;
  body?: string;
  id?: string;
}) {
  seq += 1;
  const criado = o.criado ?? DENTRO;
  await query(
    `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, recipient_name, title, body,
                         link_url, deal_id, org_name, deliver_after, kind, status, delivery_status,
                         template_name, created_at, sent_at, released_at, error_code, last_error)
     VALUES (coalesce($13, gen_random_uuid()::text), $1, $2, 'platform_user', $3, 'Ana', 't', $4,
             NULL, NULL, 'Org M', $5, $6, $7, $8, $9, $5, $10, $11, $12, $14)`,
    [
      o.org ?? ORG,
      `metricas-${seq}`,
      o.phone ?? `55119000${String(seq).padStart(5, "0")}`,
      o.body ?? `corpo ${seq}`,
      criado,
      o.kind,
      o.status ?? "sent",
      o.entrega ?? null,
      o.template ?? null,
      o.enviado === undefined ? criado : o.enviado,
      o.liberado ?? null,
      o.erro ?? null,
      o.id ?? null,
      o.lastError ?? null,
    ]
  );
}

async function inbound(id: string, fone: string, quando: string, payload: string | null = null) {
  await query(
    `INSERT INTO inbound_queue (id, message_id, from_phone, kind, text, status, created_at, button_payload)
     VALUES (gen_random_uuid()::text, $1, $2, 'text', 'oi', 'done', $3, $4)`,
    [id, fone, quando, payload]
  );
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = ANY($1)`, [[ORG, OUTRA]]);
  await query(`DELETE FROM inbound_queue WHERE message_id LIKE 'metricas-%'`);
}

type Ms = Awaited<ReturnType<typeof metricasDoMax>>["metricas"];
const valor = (ms: Ms, nome: string) => ms.find((x) => x.nome === nome)?.valor;
const amostra = (ms: Ms, nome: string) => ms.find((x) => x.nome === nome)?.amostra;

d("métricas da régua — banco do Max (Postgres real)", () => {
  let ms: Ms;

  beforeAll(async () => {
    await limpar();
    // G1: 5 avisos da régua SAÍRAM; 3 entregues/lidos. Um deles falhou na
    // Meta DEPOIS de sair (status failed, sent_at mantido) — continua no
    // denominador.
    await linha({ kind: "form_completed", entrega: "delivered", template: "max_formulario_concluido" });
    await linha({ kind: "contract_signed", entrega: "read" });
    await linha({ kind: "form_reminder_parte", entrega: "read" });
    await linha({ kind: "form_completed", entrega: null });
    await linha({ kind: "form_completed", status: "failed", entrega: "failed", erro: 131026 });
    // Template recusado no envio: nunca saiu, marca própria (não entra no
    // denominador, entra na falha de template).
    await linha({
      kind: "form_completed",
      status: "pending",
      enviado: null,
      lastError: "template_invalido: a Meta recusou o template no envio (#132000, max_formulario_concluido)",
    });
    // Não contam: outra org, fora do período, fora da régua.
    await linha({ org: OUTRA, kind: "form_completed", entrega: null });
    await linha({ kind: "form_completed", entrega: null, criado: "2026-04-05T12:00:00Z" });
    await linha({ kind: "stage_change", entrega: null });
    // Guardrail: fora da régua que saiu por template — com kind e com kind NULL;
    // e uma tentativa que NÃO saiu (não é paga).
    await linha({ kind: "stage_change", template: "max_formulario_concluido" });
    await linha({ kind: null, template: "max_formulario_concluido" });
    await linha({ kind: "stage_change", status: "pending", enviado: null, template: "max_formulario_concluido" });
    // G1 duplicados: o MESMO aviso duas vezes em 1 minuto, com o id do mais
    // antigo MAIOR (UUID não é cronológico).
    await linha({ kind: "contract_signed", phone: "5511900088001", body: "dup", id: "zzzz-antigo", enviado: "2026-03-11T10:00:00Z" });
    await linha({ kind: "contract_signed", phone: "5511900088001", body: "dup", id: "aaaa-novo", enviado: "2026-03-11T10:01:00Z" });
    // G2: 3 mensagens por template; 1 aceita em 2h, 1 aceita em 5 dias, 1 sem OK.
    await linha({ kind: "manual_message", template: "max_mensagem_imobiliaria", liberado: "2026-03-10T17:00:00Z" });
    await linha({ kind: "manual_message_parte", template: "max_mensagem_imobiliaria", liberado: "2026-03-15T15:00:00Z" });
    await linha({ kind: "manual_message", template: "max_mensagem_imobiliaria" });
    // G5: 3 boas-vindas; uma escreve em 3 dias, outra só TOCA em botão, a
    // terceira escreve só em 9 dias.
    await linha({ kind: "welcome", phone: "5511900077001", template: "max_boas_vindas" });
    await linha({ kind: "welcome", phone: "5511900077002", template: "max_boas_vindas" });
    await linha({ kind: "welcome", phone: "5511900077003", template: "max_boas_vindas" });
    await inbound("metricas-a", "5511900077001", "2026-03-13T15:00:00Z");
    await inbound("metricas-b", "5511900077002", "2026-03-11T15:00:00Z", "ok:linha");
    await inbound("metricas-c", "5511900077003", "2026-03-19T15:00:00Z");

    ms = (await somenteLeitura(URL_TESTE, (c) => metricasDoMax(c, { desde: DESDE, ate: ATE, org: ORG })))
      .metricas;
  });

  afterAll(limpar);

  it("G1: o denominador é quem SAIU — inclusive quem falhou depois de sair", () => {
    // Saíram: 5 do bloco G1 + 2 duplicados + 3 manuais + 3 boas-vindas = 13;
    // entregues/lidos: 3.
    expect(amostra(ms, "avisos da régua entregues/lidos")).toBe(13);
    expect(valor(ms, "avisos da régua entregues/lidos")).toBeCloseTo(3 / 13);
  });

  it("G1: template recusado no ENVIO conta como falha de template", () => {
    expect(valor(ms, "falhas por template inválido (132xxx)")).toBe(1);
  });

  it("G1: duplicado é achado mesmo com o id do mais antigo maior", () => {
    expect(valor(ms, "envios duplicados")).toBe(1);
  });

  it("G2: OK em até 7 dias", () => {
    expect(valor(ms, "mensagens com OK em até 7 dias")).toBeCloseTo(2 / 3);
    // Medianas de 2h e 120h → 61h.
    expect(valor(ms, "mediana até o OK (de quem deu OK)")).toBeCloseTo(61);
  });

  it("G5: toque em botão não é conversa; fora dos 7 dias não conta", () => {
    expect(valor(ms, "quem recebeu as boas-vindas e escreveu em 7 dias")).toBeCloseTo(1 / 3);
  });

  it("guardrail: fora da régua pago conta kind NULL e ignora tentativa que não saiu", () => {
    expect(valor(ms, "avisos fora da régua pagos (por template)")).toBe(2);
  });
});

d("métricas da régua — janela madura", () => {
  afterAll(limpar);

  it("mensagem de ontem ainda não entra no denominador do OK em 7 dias", async () => {
    await limpar();
    const ontem = new Date(Date.now() - 86_400_000).toISOString();
    await linha({ kind: "manual_message", template: "max_mensagem_imobiliaria", criado: ontem });
    const r = await somenteLeitura(URL_TESTE, (c) =>
      metricasDoMax(c, { desde: new Date(Date.now() - 30 * 86_400_000), ate: new Date(), org: ORG })
    );
    expect(amostra(r.metricas, "mensagens com OK em até 7 dias")).toBe(0);
    expect(valor(r.metricas, "mensagens com OK em até 7 dias")).toBeNull();
  });
});

d("somenteLeitura", () => {
  it("a transação é read-only: escrever falha", async () => {
    await expect(
      somenteLeitura(URL_TESTE, (c) => c.query(`DELETE FROM outbox WHERE org_id = 'nada'`))
    ).rejects.toThrow(/read-only/);
  });

  it("vale mesmo com `?options=` na URL (que sobrescreveria um parâmetro de startup)", async () => {
    const url = `${URL_TESTE}${URL_TESTE.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c application_name=metricas")}`;
    const r = await somenteLeitura(url, async (c) => (await c.query("SHOW transaction_read_only")).rows[0]);
    expect(r).toEqual({ transaction_read_only: "on" });
  });
});

/**
 * O lado do contractmaker contra tabelas com o MESMO formato do Prisma
 * (`timestamp(3)` sem fuso, gravado em UTC), criadas num schema temporário.
 */
d("métricas da régua — banco do contractmaker (formato Prisma)", () => {
  const SCHEMA = "cm_metricas_teste";

  beforeAll(async () => {
    await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await query(`CREATE SCHEMA ${SCHEMA}`);
    await query(`CREATE TABLE ${SCHEMA}."Organization" (id text PRIMARY KEY, "onboardingCompletedAt" timestamp(3))`);
    await query(
      `CREATE TABLE ${SCHEMA}."TenantSignupRequest" (id text PRIMARY KEY, "orgId" text, status text, "decidedAt" timestamp(3))`
    );
    await query(
      `CREATE TABLE ${SCHEMA}."SurveyInvite" (id text PRIMARY KEY, "orgId" text, channel text,
         "createdAt" timestamp(3), "sentAt" timestamp(3), "respondedAt" timestamp(3))`
    );
    // Aprovada 01:00 UTC do dia 01/03 = 22:00 de 28/02 em São Paulo: FORA de
    // um período que começa em 01/03 00:00 BRT (03:00 UTC).
    await query(`INSERT INTO ${SCHEMA}."Organization" VALUES ('o-fora', '2026-03-01 05:00:00')`);
    await query(`INSERT INTO ${SCHEMA}."TenantSignupRequest" VALUES ('t-fora', 'o-fora', 'approved', '2026-03-01 01:00:00')`);
    // Dentro: uma conclui em 1 dia, outra em 5.
    await query(`INSERT INTO ${SCHEMA}."Organization" VALUES ('o-rapida', '2026-03-11 12:00:00'), ('o-lenta', '2026-03-15 12:00:00')`);
    await query(
      `INSERT INTO ${SCHEMA}."TenantSignupRequest" VALUES ('t-r', 'o-rapida', 'approved', '2026-03-10 12:00:00'),
                                                         ('t-l', 'o-lenta', 'approved', '2026-03-10 12:00:00')`
    );
    // Pesquisa: 2 enviadas, 1 respondida; 1 criada mas nunca enviada.
    await query(
      `INSERT INTO ${SCHEMA}."SurveyInvite" VALUES
         ('s1', 'o-rapida', 'whatsapp', '2026-03-10 12:00:00', '2026-03-10 12:00:01', '2026-03-11 09:00:00'),
         ('s2', 'o-rapida', 'whatsapp', '2026-03-10 12:00:00', '2026-03-10 12:00:01', NULL),
         ('s3', 'o-rapida', 'whatsapp', '2026-03-10 12:00:00', NULL, NULL)`
    );
  });

  afterAll(async () => {
    await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  it("período em UTC (sem escorregar 3h), conclusão em 2 dias, lembrete em 7 e pesquisa enviada", async () => {
    const ms = await somenteLeitura(URL_TESTE, async (c) => {
      await c.query(`SET LOCAL search_path TO ${SCHEMA}`);
      return metricasDoContractmaker(c, { desde: DESDE, ate: ATE, org: null }, [
        // Lembrada em 13/03: concluiu em 15/03 (dentro dos 7 dias).
        { org_id: "o-lenta", sent_at: new Date("2026-03-13T12:00:00Z") },
      ]);
    });
    expect(amostra(ms, "tenants que concluíram a configuração em até 2 dias")).toBe(2);
    expect(valor(ms, "tenants que concluíram a configuração em até 2 dias")).toBeCloseTo(1 / 2);
    expect(valor(ms, "lembrados que concluíram em até 7 dias")).toBe(1);
    expect(amostra(ms, "pesquisas respondidas (WhatsApp)")).toBe(2);
    expect(valor(ms, "pesquisas respondidas (WhatsApp)")).toBeCloseTo(1 / 2);
  });
});

d("métricas da régua — guardrail de MARKETING", () => {
  const NOMES = ["max_formulario_concluido", "max_formulario_concluido_v2", "max_boas_vindas", "max_boas_vindas_v2"];
  afterAll(async () => {
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
  });

  it("v1 MARKETING aposentado por v2 aprovado não conta; v1 MARKETING ainda em uso conta", async () => {
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
    await query(
      `INSERT INTO wa_template (name, lang, status, category) VALUES
         ('max_formulario_concluido', 'pt_BR', 'APPROVED', 'MARKETING'),
         ('max_formulario_concluido_v2', 'pt_BR', 'APPROVED', 'UTILITY'),
         ('max_boas_vindas', 'pt_BR', 'APPROVED', 'MARKETING'),
         ('max_boas_vindas_v2', 'pt_BR', 'PENDING', 'UTILITY')`
    );
    const r = await somenteLeitura(URL_TESTE, (c) => metricasDoMax(c, { desde: DESDE, ate: ATE, org: ORG }));
    expect(valor(r.metricas, "templates max_* classificados como MARKETING")).toBe("max_boas_vindas");
  });
});
