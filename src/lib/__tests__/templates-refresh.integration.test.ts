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

/** Responde a Graph por nome: `porNome[name]` = lista que a Meta devolveria. */
function graph(porNome: Record<string, unknown[]>) {
  return vi.fn(async (url: string) => {
    const nome = new URL(url).searchParams.get("name") ?? "";
    return new Response(JSON.stringify({ data: porNome[nome] ?? [] }), { status: 200 });
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

  it("token sem permissão: para no primeiro erro, sem 11 chamadas iguais", async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: 200, message: "permission" } }), { status: 403 })
    );
    vi.stubGlobal("fetch", f);
    const r = await refreshTemplates();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(1);
    expect(r[0].acao).toBe("erro");
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
