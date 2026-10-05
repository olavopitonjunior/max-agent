import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

/**
 * O refresh de status de template contra o Postgres real e uma Graph API
 * simulada. O webhook de status não chega a este serviço (02/10/2026): é
 * este caminho que faz um template APROVADO passar a ser usado.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { refreshTemplates } = await import("../templates/refresh");
const { CATALOGO, todosOsTemplates } = await import("../templates/catalog");
const { query } = await import("../db");

const DEF = CATALOGO.form_completed;
const NOMES = todosOsTemplates().map((t) => t.name);

/**
 * A Graph da listagem: `porNome[name]` = o que a Meta tem com aquele nome. Sem
 * `name` na URL (a listagem que o refresh usa), devolve tudo junto — numa
 * página só, ou em páginas de `porPagina` itens ligadas por `paging.next`.
 */
function graph(porNome: Record<string, unknown[]>, porPagina = 0) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url);
    const nome = u.searchParams.get("name");
    if (nome !== null) return new Response(JSON.stringify({ data: porNome[nome] ?? [] }), { status: 200 });
    const todos = Object.values(porNome).flat();
    if (!porPagina) return new Response(JSON.stringify({ data: todos }), { status: 200 });
    const de = Number(u.searchParams.get("after") ?? 0);
    const next = de + porPagina < todos.length ? `${u.origin}${u.pathname}?after=${de + porPagina}` : undefined;
    return new Response(JSON.stringify({ data: todos.slice(de, de + porPagina), paging: { next } }), { status: 200 });
  });
}

const naMeta = (over: Record<string, unknown> = {}) => ({
  name: DEF.name,
  status: "APPROVED",
  language: "pt_BR",
  id: "meta-1",
  components: [
    { type: "BODY", text: DEF.body },
    { type: "BUTTONS", buttons: [{ type: "URL" }] },
  ],
  ...over,
});

async function status(name: string) {
  return (await query<{ status: string }>(`SELECT status FROM wa_template WHERE name = $1`, [name]))[0]?.status ?? null;
}

d("refreshTemplates", () => {
  beforeEach(async () => {
    vi.stubEnv("META_WABA_ID", "waba-teste");
    vi.stubEnv("META_ACCESS_TOKEN", "tok");
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
  });

  it("PENDING local + APPROVED na Meta com o texto do catálogo → APPROVED", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    vi.stubGlobal("fetch", graph({ [DEF.name]: [naMeta()] }));
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)).toEqual({
      name: DEF.name,
      acao: "atualizado",
      de: "PENDING",
      para: "APPROVED",
    });
    expect(await status(DEF.name)).toBe("APPROVED");
  });

  it("APPROVED na Meta com TEXTO diferente do catálogo → não grava (sairia 132000)", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    vi.stubGlobal(
      "fetch",
      graph({ [DEF.name]: [naMeta({ components: [{ type: "BODY", text: "outro texto {{1}}." }] })] })
    );
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("diverge");
    expect(await status(DEF.name)).toBe("PENDING");
  });

  it("APPROVED local que passou a divergir (texto ou botões) deixa de ser usado", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [DEF.name]);
    vi.stubGlobal(
      "fetch",
      graph({ [DEF.name]: [naMeta({ components: [{ type: "BODY", text: DEF.body }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY" }] }] })] })
    );
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("diverge");
    expect(await status(DEF.name)).toBe("DIVERGENTE");
  });

  it("aspas tipográficas e espaços a mais na Meta não contam como divergência", async () => {
    const def = CATALOGO.onboarding_pending; // tem "Tenho uma dúvida" entre aspas
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [def.name]);
    const textoMeta = def.body.replace(/"([^"]*)"/g, "\u201C$1\u201D").replace(/ /g, "  ");
    vi.stubGlobal(
      "fetch",
      graph({
        [def.name]: [
          naMeta({
            name: def.name,
            components: [
              { type: "BODY", text: textoMeta },
              { type: "BUTTONS", buttons: [{ type: "URL" }, { type: "QUICK_REPLY" }] },
            ],
          }),
        ],
      })
    );
    await refreshTemplates();
    expect(await status(def.name)).toBe("APPROVED");
  });

  it("token sem permissão: uma chamada só, e nenhum template afirmado", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 200, message: "permission" } }), { status: 403 })
    );
    vi.stubGlobal("fetch", f);
    const r = await refreshTemplates();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(NOMES.length);
    expect(r.every((x) => x.acao === "erro")).toBe(true);
  });

  it("uma listagem por passada (não uma busca por template), seguindo a paginação", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    const outros = Array.from({ length: 5 }, (_, i) => naMeta({ name: `fincasa_outro_${i}`, id: `x${i}` }));
    // O nosso template só aparece na ÚLTIMA página.
    const f = graph({ outros, [DEF.name]: [naMeta()] }, 2);
    vi.stubGlobal("fetch", f);
    const r = await refreshTemplates();
    expect(f).toHaveBeenCalledTimes(3);
    for (const c of f.mock.calls) {
      expect(new URL(String(c[0])).searchParams.get("name")).toBeNull();
      // Sem isto o Next guarda a resposta no Data Cache — a causa do "ausente" de 03/10.
      expect((c[1] as RequestInit).cache).toBe("no-store");
    }
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("atualizado");
    expect(await status(DEF.name)).toBe("APPROVED");
  });

  it("listagem além do teto de páginas: nada é afirmado (um 'ausente' apagaria APPROVED)", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [DEF.name]);
    const muitos = Array.from({ length: 25 }, (_, i) => naMeta({ name: `fincasa_outro_${i}`, id: `x${i}` }));
    vi.stubGlobal("fetch", graph({ muitos }, 1));
    const r = await refreshTemplates();
    expect(r.every((x) => x.acao === "erro")).toBe(true);
    expect(await status(DEF.name)).toBe("APPROVED");
  });

  it("página do meio falha: nada é gravado, nem o APPROVED some", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [DEF.name]);
    let chamada = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        chamada += 1;
        if (chamada === 1) {
          return new Response(
            JSON.stringify({
              data: [naMeta({ name: "fincasa_outro" })],
              paging: { next: "https://graph.facebook.com/v24.0/x?after=1" },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ error: { message: "falhou" } }), { status: 500 });
      })
    );
    const r = await refreshTemplates();
    expect(r.every((x) => x.acao === "erro")).toBe(true);
    expect(await status(DEF.name)).toBe("APPROVED");
  });

  it("paginação apontando para outro host não é seguida (o token vai no header)", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ data: [], paging: { next: "https://evil.example/next" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", f);
    const r = await refreshTemplates();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.every((x) => x.acao === "erro")).toBe(true);
  });

  it("submetido e não listado: avisa com quantos vieram", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", graph({ outro: [naMeta({ name: "fincasa_outro" })] }));
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("ausente");
    const tudo = [...aviso.mock.calls, ...info.mock.calls].flat().join(" ");
    expect(tudo).toContain("templates.ausente_na_lista");
    aviso.mockRestore();
    info.mockRestore();
  });

  it("só o idioma do catálogo e o nome exato valem (o filtro da Graph é por prefixo)", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    vi.stubGlobal(
      "fetch",
      graph({
        [DEF.name]: [
          naMeta({ language: "en_US" }),
          naMeta({ name: `${DEF.name}_v2` }),
        ],
      })
    );
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("ausente");
    expect(await status(DEF.name)).toBe("PENDING");
  });

  it("APPROVED local que sumiu da Meta deixa de ser usado", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [DEF.name]);
    vi.stubGlobal("fetch", graph({}));
    await refreshTemplates();
    expect(await status(DEF.name)).not.toBe("APPROVED");
  });

  it("REJECTED traz o motivo; 'NONE' não vira motivo", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'PENDING')`, [DEF.name]);
    vi.stubGlobal("fetch", graph({ [DEF.name]: [naMeta({ status: "REJECTED", rejected_reason: "INVALID_FORMAT" })] }));
    await refreshTemplates();
    const [row] = await query<{ status: string; rejected_reason: string | null }>(
      `SELECT status, rejected_reason FROM wa_template WHERE name = $1`,
      [DEF.name]
    );
    expect(row).toEqual({ status: "REJECTED", rejected_reason: "INVALID_FORMAT" });
  });

  it("erro da Graph não apaga nada e vira `erro` no relatório", async () => {
    await query(`INSERT INTO wa_template (name, lang, status) VALUES ($1, 'pt_BR', 'APPROVED')`, [DEF.name]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "token" } }), { status: 401 }))
    );
    const r = await refreshTemplates();
    expect(r.find((x) => x.name === DEF.name)?.acao).toBe("erro");
    expect(await status(DEF.name)).toBe("APPROVED");
  });
});

d("refresh — categoria", () => {
  beforeEach(async () => {
    vi.stubEnv("META_WABA_ID", "waba-teste");
    vi.stubEnv("META_ACCESS_TOKEN", "tok");
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reclassificação da Meta (UTILITY → MARKETING) fica gravada", async () => {
    await query(`INSERT INTO wa_template (name, lang, status, category) VALUES ($1, 'pt_BR', 'APPROVED', 'UTILITY')`, [DEF.name]);
    vi.stubGlobal("fetch", graph({ [DEF.name]: [naMeta({ category: "MARKETING" })] }));
    await refreshTemplates();
    const [row] = await query<{ category: string }>(`SELECT category FROM wa_template WHERE name = $1`, [DEF.name]);
    expect(row.category).toBe("MARKETING");
  });
});

d("refresh — categoria na primeira gravação", () => {
  beforeEach(async () => {
    vi.stubEnv("META_WABA_ID", "waba-teste");
    vi.stubEnv("META_ACCESS_TOKEN", "tok");
    await query(`DELETE FROM wa_template WHERE name = ANY($1)`, [NOMES]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("template novo aqui já entra com a categoria que a Meta deu", async () => {
    vi.stubGlobal("fetch", graph({ [DEF.name]: [naMeta({ category: "MARKETING" })] }));
    await refreshTemplates();
    const [row] = await query<{ category: string }>(`SELECT category FROM wa_template WHERE name = $1`, [DEF.name]);
    expect(row.category).toBe("MARKETING");
  });
});
