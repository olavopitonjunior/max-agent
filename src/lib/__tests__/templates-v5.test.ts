import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import type { Aviso } from "../aviso/schema";
import type { LinhaParaTemplate } from "../templates/catalog";

/**
 * M9 — a família V5 dos templates (fora da janela de 24h, com `aviso`).
 *
 * Parte 1 (sem banco): regras do catálogo — ordem de preferência, texto de
 * botão, quando o V5 é usável. Parte 2 (Postgres de teste): a SELEÇÃO REAL do
 * `dispatchDue` — o V5 sai quando aprovado, o anterior sai quando o V5 está
 * pendente, e o payload da Meta leva `av:<id>:<ação>` e o cabeçalho de imagem.
 * A Meta nunca é chamada (`sendTemplate` mockado).
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
  sendText: vi.fn().mockResolvedValue({ messageId: "wamid.TXT" }),
  sendTemplate: vi.fn().mockResolvedValue({ messageId: "wamid.TPL" }),
  connectionStatus: vi.fn().mockResolvedValue({ connected: true, raw: {} }),
}));

const { enqueue, dispatchDue, botoesDaLinha, imagemCabecalhoDaLinha } = await import("../outbox");
const catalogo = await import("../templates/catalog");
const { query } = await import("../db");
const meta = await import("../meta");
const metaSendTemplate = meta.sendTemplate as unknown as ReturnType<typeof vi.fn>;

const {
  CATALOGO,
  templateUsavel,
  todosOsTemplates,
  botoesEmOrdem,
  submeteSoPeloGerenciador,
} = catalogo;

/**
 * Aqui a lista é a da família V5 (prioridade máxima da régua antiga). A V6
 * (UTILITY de reserva, 29/10/2026) fica na frente dela no catálogo real e é
 * coberta em `catalog.test.ts`; sai da lista para estas regras seguirem
 * afirmando o V5.
 */
const templatesDoKind = (kind: string | null | undefined) =>
  catalogo.templatesDoKind(kind).filter((t) => !t.name.endsWith("_v6"));
const templateDoKind = (kind: string | null | undefined) => templatesDoKind(kind)[0] ?? null;

const V5_DEFS = todosOsTemplates().filter((t) => t.name.endsWith("_v5"));

const AVISO_FORM: Aviso = {
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

const AVISO_MARCO: Aviso = {
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
  imagemUrl: "https://trio.imobpro.ia.br/api/og/marco/abc",
};

/** Uma linha mínima do outbox para `templateUsavel`. */
function linhaDe(aviso: Aviso | null, extra: Partial<LinhaParaTemplate> = {}): LinhaParaTemplate {
  return {
    recipient_name: "Ana Souza",
    org_name: "RE/MAX Trio",
    title: "Formulário aguardando",
    params: { negocio: "Venda Apto 302" },
    aviso,
    audience: "platform_user",
    link_url: "https://trio.imobpro.ia.br/deals/cmx1",
    deal_id: "deal1",
    ...extra,
  };
}

const KINDS_V5 = [
  "stage_change",
  "deal_stage_change",
  "form_reminder",
  "deal_form_reminder",
  "proposal_created_status",
  "proposal_sent",
  "proposal_delivered",
  "activity_assigned",
  "activity_due",
  "activity_due_soon",
  "contract_signed",
  "contract_signed_status",
];

describe("família V5 — catálogo", () => {
  it("são cinco templates, todos UTILITY pt_BR, com o sufixo _v5", () => {
    expect(V5_DEFS.map((t) => t.name).sort()).toEqual([
      "max_atividades_v5",
      "max_formulario_pendente_v5",
      "max_marco_v5",
      "max_negocio_andamento_v5",
      "max_proposta_v5",
    ]);
    for (const t of V5_DEFS) {
      expect(t.category, t.name).toBe("UTILITY");
      expect(t.lang, t.name).toBe("pt_BR");
    }
  });

  it("templatesDoKind: o V5 vem primeiro, depois [v4, v3, v2, v1]", () => {
    for (const k of KINDS_V5) {
      const lista = templatesDoKind(k);
      expect(lista[0].name, k).toMatch(/_v5$/);
      expect(lista[lista.length - 1], k).toBe(CATALOGO[k]);
      expect(lista.filter((x) => x.name.endsWith("_v5")), k).toHaveLength(1);
    }
    expect(templateDoKind("form_reminder")!.name).toBe("max_formulario_pendente_v5");
  });

  it("o mapa dos kinds: etapa, formulário, proposta, atividade e marco", () => {
    const nome = (k: string) => templateDoKind(k)!.name;
    for (const k of ["stage_change", "deal_stage_change"]) expect(nome(k)).toBe("max_negocio_andamento_v5");
    for (const k of ["form_reminder", "deal_form_reminder"]) expect(nome(k)).toBe("max_formulario_pendente_v5");
    for (const k of ["proposal_created_status", "proposal_sent", "proposal_delivered"])
      expect(nome(k)).toBe("max_proposta_v5");
    for (const k of ["activity_assigned", "activity_due", "activity_due_soon"]) expect(nome(k)).toBe("max_atividades_v5");
    for (const k of ["contract_signed", "contract_signed_status"]) expect(nome(k)).toBe("max_marco_v5");
  });

  it("proposal_completed NÃO tem V5: segue no v2, com o Converter", () => {
    expect(templatesDoKind("proposal_completed").some((t) => t.name.endsWith("_v5"))).toBe(false);
    expect(templateDoKind("proposal_completed")!.name).not.toMatch(/_v5$/);
  });

  it("kind de PARTE nunca ganha V5 (a parte não conversa com o Max)", () => {
    const partes = Object.keys(CATALOGO).filter((k) => k.endsWith("_parte"));
    expect(partes.length).toBeGreaterThan(0);
    for (const k of partes) expect(templatesDoKind(k).some((t) => t.name.endsWith("_v5")), k).toBe(false);
  });

  it("kind fora da régua continua sem template (captacao_signed_status não está no catálogo)", () => {
    expect(templatesDoKind("captacao_signed_status")).toEqual([]);
    expect(templatesDoKind("deal_sla_breached")).toEqual([]);
  });

  it("texto de botão: sem emoji e até 20 caracteres", () => {
    for (const t of V5_DEFS) {
      const botoes = botoesEmOrdem(t.botao);
      expect(botoes.length, t.name).toBeGreaterThanOrEqual(1);
      expect(botoes.length, t.name).toBeLessThanOrEqual(3);
      for (const b of botoes) {
        expect(b.texto.length, `${t.name}/${b.texto}`).toBeLessThanOrEqual(20);
        expect(b.texto, `${t.name}/${b.texto}`).toMatch(/^[\p{L}\p{N} ]+$/u);
      }
    }
  });

  it("o corpo abre com o emoji fixo do evento; o botão nunca leva emoji", () => {
    const emojis: Record<string, string> = {
      max_negocio_andamento_v5: "📌",
      max_formulario_pendente_v5: "⏳",
      max_proposta_v5: "📝",
      max_atividades_v5: "📋",
      max_marco_v5: "🎉",
    };
    for (const t of V5_DEFS) expect(t.body.startsWith(`${emojis[t.name]} Olá, {{1}}!`), t.name).toBe(true);
  });

  it("botões na ordem do brief, cada um com a sua ação", () => {
    const pares = (nome: string) =>
      botoesEmOrdem(V5_DEFS.find((t) => t.name === nome)!.botao).map((b) => `${b.texto}>${"acao" in b ? b.acao : "?"}`);
    expect(pares("max_negocio_andamento_v5")).toEqual(["Abrir negócio>abrir"]);
    expect(pares("max_formulario_pendente_v5")).toEqual([
      "Reenviar link>reenviar_link",
      "Me lembra amanhã>lembrar_amanha",
      "Ver formulário>ver_formulario",
    ]);
    expect(pares("max_proposta_v5")).toEqual(["Ver proposta>ver_proposta", "Abrir negócio>abrir"]);
    expect(pares("max_atividades_v5")).toEqual(["Ver atividades>abrir"]);
    expect(pares("max_marco_v5")).toEqual(["Abrir negócio>abrir", "Próximo passo>criar_atividade"]);
  });

  it("nenhum V5 oferece concluir/adiar_1d (activity.write OFF)", () => {
    for (const t of V5_DEFS)
      for (const b of botoesEmOrdem(t.botao)) {
        if ("acao" in b) expect(["concluir", "adiar_1d"], t.name).not.toContain(b.acao);
      }
  });

  it("atividades segue 'um por janela'; só o marco tem cabeçalho de imagem", () => {
    expect(V5_DEFS.filter((t) => t.umPorJanela).map((t) => t.name)).toEqual(["max_atividades_v5"]);
    expect(V5_DEFS.filter((t) => t.cabecalho).map((t) => t.name)).toEqual(["max_marco_v5"]);
  });

  it("o sync pula o template de cabeçalho de imagem (quem submete é o Gerenciador)", () => {
    expect(submeteSoPeloGerenciador(V5_DEFS.find((t) => t.name === "max_marco_v5")!)).toBe(true);
    for (const t of todosOsTemplates().filter((x) => x.name !== "max_marco_v5"))
      expect(submeteSoPeloGerenciador(t), t.name).toBe(false);
  });

  it("botoesDaLinha: payload av:<id>:<ação>, na ordem de botoesEmOrdem", () => {
    const def = templateDoKind("form_reminder")!;
    expect(botoesDaLinha(def, "row-9")).toEqual([
      { tipo: "quick_reply", payload: "av:row-9:reenviar_link" },
      { tipo: "quick_reply", payload: "av:row-9:lembrar_amanha" },
      { tipo: "quick_reply", payload: "av:row-9:ver_formulario" },
    ]);
    expect(botoesDaLinha(templateDoKind("proposal_sent")!, "r1")).toEqual([
      { tipo: "quick_reply", payload: "av:r1:ver_proposta" },
      { tipo: "quick_reply", payload: "av:r1:abrir" },
    ]);
  });

  it("imagemCabecalhoDaLinha: só o template com cabeçalho leva a imagem do aviso", () => {
    expect(imagemCabecalhoDaLinha(templateDoKind("contract_signed")!, { aviso: AVISO_MARCO })).toBe(AVISO_MARCO.imagemUrl);
    expect(imagemCabecalhoDaLinha(templateDoKind("form_reminder")!, { aviso: AVISO_MARCO })).toBeUndefined();
    expect(imagemCabecalhoDaLinha(templateDoKind("contract_signed")!, { aviso: null })).toBeUndefined();
  });
});

describe("família V5 — templateUsavel", () => {
  const form = () => templateDoKind("form_reminder")!;
  const marco = () => templateDoKind("contract_signed")!;

  it("com aviso que traz TODAS as ações do botão, é usável", () => {
    expect(templateUsavel(form(), linhaDe(AVISO_FORM))).toBe(true);
    expect(templateUsavel(marco(), linhaDe(AVISO_MARCO))).toBe(true);
  });

  it("linha sem aviso (emissor antigo) nunca usa V5", () => {
    for (const k of KINDS_V5) expect(templateUsavel(templateDoKind(k)!, linhaDe(null)), k).toBe(false);
    expect(templateUsavel(form(), linhaDe(undefined as unknown as null))).toBe(false);
  });

  it("os templates anteriores ignoram o aviso (continuam usáveis sem ele)", () => {
    for (const k of KINDS_V5) {
      const anterior = templatesDoKind(k).filter((t) => !t.name.endsWith("_v5"));
      for (const t of anterior) {
        const ok = !t.paramsObrigatorios || t.paramsObrigatorios.length === 0;
        if (ok) expect(templateUsavel(t, linhaDe(null)), t.name).toBe(true);
      }
    }
  });

  it("atividade como o contractmaker emite hoje (só `abrir`, activity.write OFF) usa o V5", () => {
    const avisoAtividade: Aviso = { ...AVISO_MARCO, imagemUrl: undefined, acoes: [{ id: "abrir" }] };
    for (const k of ["activity_assigned", "activity_due", "activity_due_soon"]) {
      expect(templateUsavel(templateDoKind(k)!, linhaDe(avisoAtividade)), k).toBe(true);
    }
  });

  it("aviso de PARTE (deal_party) nunca usa V5", () => {
    expect(templateUsavel(form(), linhaDe(AVISO_FORM, { audience: "deal_party" }))).toBe(false);
  });

  it("falta uma das ações do botão em aviso.acoes: não é usável (o roteador recusaria o toque)", () => {
    const semLembrar: Aviso = { ...AVISO_FORM, acoes: AVISO_FORM.acoes.filter((a) => a.id !== "lembrar_amanha") };
    expect(templateUsavel(form(), linhaDe(semLembrar))).toBe(false);
    const semCriar: Aviso = { ...AVISO_MARCO, acoes: [{ id: "abrir" }] };
    expect(templateUsavel(marco(), linhaDe(semCriar))).toBe(false);
  });

  it("reenviar_link exige o alvoId da ação e o deal_id da linha", () => {
    const semAlvo: Aviso = {
      ...AVISO_FORM,
      acoes: [{ id: "reenviar_link" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
    };
    expect(templateUsavel(form(), linhaDe(semAlvo))).toBe(false);
    expect(templateUsavel(form(), linhaDe(AVISO_FORM, { deal_id: null }))).toBe(false);
  });

  it("ação de link exige o link do aviso (ou o link_url da linha)", () => {
    const semLink: Aviso = { ...AVISO_FORM, link: null };
    expect(templateUsavel(form(), linhaDe(semLink, { link_url: null }))).toBe(false);
    expect(templateUsavel(form(), linhaDe(semLink, { link_url: "https://trio.imobpro.ia.br/deals/cmx1" }))).toBe(true);
  });

  it("max_marco_v5 sem imagemUrl https não é usável", () => {
    const { imagemUrl: _i, ...semImagem } = AVISO_MARCO;
    expect(templateUsavel(marco(), linhaDe(semImagem as Aviso))).toBe(false);
    expect(templateUsavel(marco(), linhaDe({ ...AVISO_MARCO, imagemUrl: "http://x.test/a.png" }))).toBe(false);
  });
});

/* ───────────────────────── seleção real do outbox ───────────────────────── */

const PHONE = "5511900991188";
const ORG = "org-templates-v5";

const NOMES_DOS_KINDS = [...new Set(["form_reminder", "contract_signed"].flatMap((k) => templatesDoKind(k).map((t) => t.name)))];

async function aprovar(...names: string[]) {
  for (const name of names)
    await query(
      `INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')
       ON CONFLICT (name) DO UPDATE SET status = 'APPROVED'`,
      [name]
    );
}

async function pendente(...names: string[]) {
  for (const name of names)
    await query(
      `INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')
       ON CONFLICT (name) DO UPDATE SET status = 'PENDING'`,
      [name]
    );
}

async function linha(
  dedupeKey: string,
  kind: string,
  aviso: Aviso | null,
  extra: Partial<Parameters<typeof enqueue>[0]> = {}
) {
  const r = await enqueue({
    orgId: ORG,
    dedupeKey,
    audience: "platform_user",
    phone: PHONE,
    recipientName: "Ana Souza",
    title: "Formulário aguardando",
    body: "corpo",
    linkUrl: "https://trio.imobpro.ia.br/deals/cmx1",
    dealId: "deal1",
    orgName: "RE/MAX Trio",
    kind,
    params: { negocio: "Venda Apto 302" },
    aviso,
    ...extra,
  });
  if (r.status !== "queued") throw new Error("duplicata no setup");
  await query(`UPDATE outbox SET deliver_after = now() - interval '1 minute' WHERE id = $1`, [r.id]);
  return r.id;
}

async function limpar() {
  await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
  await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES_DOS_KINDS]);
  await query(`DELETE FROM conversation_window WHERE phone = $1`, [PHONE]);
}

d("família V5 — seleção do outbox (Postgres real, janela fechada)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    metaSendTemplate.mockResolvedValue({ messageId: "wamid.TPL" });
    vi.stubEnv("WHATSAPP_PROVIDER", "meta");
    await limpar();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(limpar);

  const anterior = (kind: string) => templatesDoKind(kind).find((t) => !t.name.endsWith("_v5"))!;

  it("_v5 APPROVED + aviso completo: sai o _v5, com botões av:<id>:<ação>", async () => {
    await aprovar("max_formulario_pendente_v5", anterior("form_reminder").name);
    const id = await linha("v5-ok", "form_reminder", AVISO_FORM);
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    const args = metaSendTemplate.mock.calls[0][0];
    expect(args.name).toBe("max_formulario_pendente_v5");
    expect(args.bodyParams).toEqual(["Ana", "Venda Apto 302", "RE/MAX Trio"]);
    expect(args.botoes).toEqual([
      { tipo: "quick_reply", payload: `av:${id}:reenviar_link` },
      { tipo: "quick_reply", payload: `av:${id}:lembrar_amanha` },
      { tipo: "quick_reply", payload: `av:${id}:ver_formulario` },
    ]);
    expect(args.imagemCabecalho).toBeUndefined();
  });

  it("_v5 PENDING e o anterior APPROVED: sai o anterior", async () => {
    const velho = anterior("form_reminder");
    await pendente("max_formulario_pendente_v5");
    await aprovar(velho.name);
    await linha("v5-pendente", "form_reminder", AVISO_FORM);
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    expect(metaSendTemplate.mock.calls[0][0].name).toBe(templatesDoKind("form_reminder").filter((t) => !t.name.endsWith("_v5"))[0].name);
  });

  it("só o _v5 aprovado e linha SEM aviso: nunca sai o V5 (represa)", async () => {
    await aprovar("max_formulario_pendente_v5");
    await linha("v5-sem-aviso", "form_reminder", null);
    await dispatchDue();

    expect(metaSendTemplate).not.toHaveBeenCalled();
    const [r] = await query<{ status: string }>(`SELECT status FROM outbox WHERE dedupe_key = 'v5-sem-aviso'`);
    expect(r.status).toBe("pending");
  });

  it("linha sem aviso, com o anterior aprovado: sai o anterior mesmo com o _v5 aprovado", async () => {
    const velho = anterior("form_reminder");
    await aprovar("max_formulario_pendente_v5", velho.name);
    await linha("v5-antigo", "form_reminder", null);
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    expect(metaSendTemplate.mock.calls[0][0].name).not.toMatch(/_v5$/);
  });

  it("aviso sem uma das ações do botão: cai no anterior (o roteador recusaria o toque)", async () => {
    const velho = anterior("form_reminder");
    await aprovar("max_formulario_pendente_v5", velho.name);
    const incompleto: Aviso = { ...AVISO_FORM, acoes: [{ id: "ver_formulario" }] };
    await linha("v5-incompleto", "form_reminder", incompleto);
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    expect(metaSendTemplate.mock.calls[0][0].name).not.toMatch(/_v5$/);
  });

  it("marco: com imagemUrl o header de imagem vai no envio", async () => {
    await aprovar("max_marco_v5", anterior("contract_signed").name);
    await linha("marco-ok", "contract_signed", AVISO_MARCO, { title: "Contrato assinado" });
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    const args = metaSendTemplate.mock.calls[0][0];
    expect(args.name).toBe("max_marco_v5");
    expect(args.imagemCabecalho).toBe(AVISO_MARCO.imagemUrl);
    expect(args.bodyParams).toEqual(["Ana", "RE/MAX Trio", "Contrato assinado"]);
    expect(args.botoes.map((b: { payload: string }) => b.payload.split(":")[2])).toEqual(["abrir", "criar_atividade"]);
  });

  it("marco sem imagemUrl: não é usável, cai no anterior e nenhum header vai", async () => {
    await aprovar("max_marco_v5", anterior("contract_signed").name);
    const { imagemUrl: _i, ...semImagem } = AVISO_MARCO;
    await linha("marco-sem-imagem", "contract_signed", semImagem as Aviso, { title: "Contrato assinado" });
    await dispatchDue();

    expect(metaSendTemplate).toHaveBeenCalledTimes(1);
    const args = metaSendTemplate.mock.calls[0][0];
    expect(args.name).not.toBe("max_marco_v5");
    expect(args.imagemCabecalho).toBeUndefined();
  });
});
