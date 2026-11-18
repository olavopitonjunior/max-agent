import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { iniciarProposta, type ContextoDoTurno, type DepsDoFluxo, type RespostaDoServidor } from "../../fluxos";

/**
 * Abertura do fluxo v2 (PR-C1): só com a feature da org, a janela de extração E o
 * servidor dizendo `fluxoV2:true`. Negado primeiro: qualquer um faltando = v1 intacto.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const ORG = "org-abertura";
const CPF = "529.982.247-25";

const OPTIONS = {
  metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }],
  signatarios: [],
  assinaturaConfigurada: true,
  modalidades: [{ schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda", modeloDisponivel: true }],
  obrigatorios: [
    { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
    { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
  ],
  tiposDeAssinatura: [],
  fluxoV2: true,
};

function montar(opts: { semJanela?: boolean; optionsBody?: Record<string, unknown> | null; args?: Record<string, unknown>; texto?: string } = {}) {
  const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
    if (verb === "proposal.options") return opts.optionsBody === null ? null : { status: 200, body: opts.optionsBody ?? OPTIONS };
    if (verb === "proposal.preflight") return { status: 200, body: { modelo: true, assinatura: true } };
    return null;
  });
  const extrairProposta = vi.fn(async () => null);
  const extrairComJanela = vi.fn(async () => opts.args ?? {});
  const texto = opts.texto ?? "proposta de compra";
  const deps = {
    acao,
    extrairProposta,
    extrairCampos: vi.fn(),
    ...(opts.semJanela ? {} : { janelaDoTurno: vi.fn(() => ({ atual: texto, anteriores: [], lidos: [] })), extrairComJanela }),
  } as unknown as DepsDoFluxo;
  const ctx: ContextoDoTurno = {
    texto, messageId: "wamid.A1", policy: ["proposal.create"], agora: 1_800_000_000_000,
    thread: "thread-abertura", orgId: ORG, subjectKey: JSON.stringify([ORG, "u1"]), podeEscrever: true,
  };
  return { acao, extrairProposta, extrairComJanela, deps, ctx, texto };
}

beforeEach(() => {
  vi.stubEnv("MAX_FORMULARIOS_V2", "true");
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
});
afterEach(() => vi.unstubAllEnvs());

describe("abertura v2 (negados primeiro)", () => {
  it("sem a janela (feature OFF): abre o v1 e nem consulta o options", async () => {
    const t = montar({ semJanela: true });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta", etapa: "coleta" });
    expect(t.acao.mock.calls.some(([v]) => v === "proposal.options")).toBe(false);
  });

  it("servidor com fluxoV2 false: abre o v1", async () => {
    const t = montar({ optionsBody: { ...OPTIONS, fluxoV2: false } });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta" });
    expect(t.extrairComJanela).not.toHaveBeenCalled();
  });

  it("feature desligada na org (rollout vazio): abre o v1", async () => {
    vi.stubEnv("MAX_ROLLOUT_ORGS", "{}");
    const t = montar();
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta" });
  });

  it("options sem resposta: abre o v1 (nunca inventa o v2)", async () => {
    const t = montar({ optionsBody: null });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta" });
  });
});

describe("P4: a intenção de formulário é lida na abertura do v2 (correção não abre proposta nova)", () => {
  it.each(["corrige a proposta da Maria", "preciso corrigir a proposta", "pode corrigir a proposta?"])(
    "%s: é pedido de correção, não abre formulário novo nem extrai o texto como dado",
    async (texto) => {
      const t = montar({ texto, args: { compradores: [{ nome: "Não Deve Extrair" }] } });
      const p = await iniciarProposta("venda", texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
      expect(p.evento).toBe("formulario_correcao");
      expect(p.fluxo).toBeNull();
      expect(t.extrairComJanela).not.toHaveBeenCalled();
    }
  );

  it.each(["não corrige a proposta", "a proposta corrige?", "a proposta foi corrigida ontem", "como corrige a proposta?"])(
    "%s: pergunta, negação ou particípio NÃO é correção: segue a abertura normal do v2",
    async (texto) => {
      const t = montar({ texto, args: {} });
      const p = await iniciarProposta("venda", texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
      expect(p.evento).not.toBe("formulario_correcao");
      expect(p.fluxo).toMatchObject({ kind: "proposta_v2", versao: 2 });
    }
  );

  it("pedido de criação com 'corrige' junto continua criação", async () => {
    const t = montar({ texto: "cria uma proposta, depois corrige o valor", args: {} });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.evento).not.toBe("formulario_correcao");
    expect(p.fluxo).toMatchObject({ kind: "proposta_v2" });
  });

  it("negado: com o servidor em fluxoV2 false a intenção nem é lida (v1 intacto, sem tolerância)", async () => {
    const t = montar({ texto: "corrige a proposta da Maria", optionsBody: { ...OPTIONS, fluxoV2: false } });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.evento).not.toBe("formulario_correcao");
    expect(p.fluxo).toMatchObject({ kind: "proposta" });
  });
});

describe("M8: modeloDisponivel ausente conta como sem modelo (igual ao derivarSchema)", () => {
  it("modalidade da esteira sem o campo modeloDisponivel: avisa que não há modelo, não abre o v2", async () => {
    const t = montar({ optionsBody: { ...OPTIONS, modalidades: [{ schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda" }] } });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.evento).toBe("proposta_sem_modelo");
    expect(p.fluxo).toBeNull();
  });
});

describe("P3 (negado): captação nunca abre o v2, nem com a feature ligada e o servidor dizendo fluxoV2", () => {
  it("iniciarCaptacao segue no v1: não consulta proposal.options, não chama a extração v2 e o fluxo não é versao 2", async () => {
    const { iniciarCaptacao } = await import("../../captacao");
    const t = montar({ args: {} });
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.options") return { status: 200, body: { modelos: [{ id: "m1", nome: "Modelo A" }] } };
      return null;
    });
    const deps = { ...t.deps, acao } as unknown as DepsDoFluxo;
    const ctx: ContextoDoTurno = { ...t.ctx, texto: "cria uma captação de venda para o Apto da Dona Maria", policy: ["captacao.create"] };
    const p = await iniciarCaptacao(ctx, deps, true);
    expect(acao.mock.calls.some(([v]) => v === "proposal.options")).toBe(false);
    expect(t.extrairComJanela).not.toHaveBeenCalled();
    expect(p.fluxo).toMatchObject({ kind: "captacao" });
    expect((p.fluxo as { versao?: number } | null)?.versao).not.toBe(2);
  });
});

describe("abertura v2 (permitidos)", () => {
  it("pedido sem dado: abre o v2 e convida a mandar os dados, sem pedir campo a campo", async () => {
    const t = montar({ args: {} });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta_v2", versao: 2, esteira: "venda" });
    expect(p.reply).toMatch(/\S/);
    expect(p.evento).toBe("formulario_aberto");
  });

  it("pedido com dado: o primeiro turno já passa pelo condutor e mostra a ficha na hora (nunca silêncio), sem CPF cru", async () => {
    const t = montar({ texto: `comprador Maria Souza Lima CPF ${CPF}`, args: { compradores: [{ nome: "Maria Souza Lima", cpf: "52998224725" }] } });
    const p = await iniciarProposta("venda", t.texto, t.ctx.agora, t.deps, undefined, undefined, t.ctx);
    expect(p.fluxo).toMatchObject({ kind: "proposta_v2" });
    expect(p.reply).toContain("***.982.247-**");
    expect(p.reply).not.toContain(CPF);
    expect(JSON.stringify(p.fluxo)).not.toContain("52998224725");
  });
});
