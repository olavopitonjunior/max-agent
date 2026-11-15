import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conduzirV2 } from "../condutor";
import { novoFluxoV2, type FluxoFormularioV2 } from "../estado";
import { TEXTO_EDITAR_PELA_TELA, itensDaRevisao } from "../revisao";
import type { OptionsV2 } from "../contrato";
import { consumirFlowDoTurno, flowDisponivel } from "../../../lib/meta-flow";
import type { ContextoDoTurno, DepsDoFluxo, RespostaDoServidor } from "../../fluxos";

/**
 * A revisão no Newton (PR-C2, T12): ficha numerada, nunca Flow, sem link (R20). O Z-API não tem
 * Flow, e a correção por número ou em frase passa pela mesma leitura e pelo mesmo SIM do Max.
 * O perfil é fixado aqui (`newton`), para valer também na suíte do Max; o config do Newton o repete.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const T0 = 1_800_000_000_000;
const THREAD = "thread-revisao-newton";
const SUBJECT = JSON.stringify(["org-1", "u1"]);
const CPF = "529.982.247-25";
const CPF_DIGITOS = "52998224725";

const OBRIGATORIOS = [
  { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "contraparte.nome", rotulo: "Nome do vendedor", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "proponente.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" },
  { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
] as const;

function options(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metodos: [],
    signatarios: [],
    assinaturaConfigurada: true,
    modalidades: [{ schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda", modeloDisponivel: true }],
    obrigatorios: OBRIGATORIOS,
    tiposDeAssinatura: [],
    fluxoV2: true,
    faltando: [{ signatario: null, campo: "negociacao.valor", motivo: "obrigatorio_da_org" }],
    ...extra,
  };
}

function montar(texto: string, args: Record<string, unknown> | null = {}, messageId = "wamid.1") {
  const acao = vi.fn(async (verb: string, _a: Record<string, unknown>, _k?: string): Promise<RespostaDoServidor | null> => {
    if (verb === "proposal.options") return { status: 200, body: options() };
    if (verb === "proposal.update") {
      return { status: 200, body: { proposta: { id: "prop-1", codigo: "PROP-1" }, faltando: [{ signatario: null, campo: "negociacao.valor", motivo: "obrigatorio_da_org" }] } };
    }
    return null;
  });
  const pausa = { agendar: vi.fn(async () => undefined), cancelar: vi.fn(async () => undefined), entregue: vi.fn(async () => false) };
  const deps = {
    acao,
    extrairProposta: vi.fn(),
    extrairCampos: vi.fn(),
    janelaDoTurno: vi.fn(() => ({ atual: texto, anteriores: [] as string[], lidos: [] as never[] })),
    extrairComJanela: vi.fn(async () => args),
    pausa,
  } as unknown as DepsDoFluxo;
  const ctx: ContextoDoTurno = { texto, messageId, policy: [], agora: T0 + 5_000, thread: THREAD, subjectKey: SUBJECT, podeEscrever: true };
  return { acao, deps, ctx };
}

const escritas = (acao: ReturnType<typeof montar>["acao"]) => acao.mock.calls.filter(([v]) => v === "proposal.create" || v === "proposal.update");

function salvo(extra: Partial<FluxoFormularioV2> = {}): FluxoFormularioV2 {
  return { ...novoFluxoV2({ esteira: "venda", agora: T0, schemaType: "compra_venda_v1" }), proposalId: "prop-1", etapa: "compor", ...extra };
}

function emRevisao(): FluxoFormularioV2 {
  return salvo({ etapa: "revisar", revisao: { passo: "partes", via: "texto", itens: itensDaRevisao(options() as unknown as OptionsV2) } });
}

beforeEach(() => {
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
  // Mesmo com tudo do Flow configurado no ambiente, o Newton nunca o usa.
  vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_IMOVEL_VALOR", "FLOW_IMOVEL");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_ASSINATURA", "FLOW_ASSIN");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Newton: ficha numerada, nunca Flow", () => {
  it("Newton recebe ficha numerada e o aviso fixo para editar pela tela, nunca Flow", async () => {
    expect(flowDisponivel("partes")).toBeNull();
    const t = montar("revisar", {}, "wamid.NEWT");
    const passo = await conduzirV2(salvo(), t.ctx, t.deps);
    expect(passo.reply).toMatch(/^1\. Comprador 1 · Nome do comprador/m);
    expect(passo.reply).toMatch(/^2\. Vendedor 1 · Nome do vendedor/m);
    expect(passo.reply).toContain(TEXTO_EDITAR_PELA_TELA);
    expect(passo.reply).not.toMatch(/https?:\/\//);
    expect(passo.reply).not.toContain("Toque em *Revisar*");
    expect(consumirFlowDoTurno("wamid.NEWT")).toBeUndefined();
    expect((passo.fluxo as FluxoFormularioV2).revisao).toMatchObject({ passo: "partes", via: "texto" });
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("mesmo que o estado traga um link no checkpoint antigo, a ficha nunca o mostra (I4/R20)", async () => {
    const t = montar("revisar");
    const passo = await conduzirV2(salvo({ linkDaTela: "https://exemplo.test/doc" } as never), t.ctx, t.deps);
    expect(passo.reply).not.toMatch(/https?:\/\//);
    expect(passo.reply).toContain("abra a proposta no sistema");
  });

  it("o Flow nunca vem de uma resposta com cara de Flow: no Newton é texto comum", async () => {
    const t = montar(`compradores_0__nome: Maria Souza\ncompradores_0__cpf: ${CPF}`, {});
    const passo = await conduzirV2(emRevisao(), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply ?? "").not.toMatch(/não anotei nada/i);
  });
});

describe("Newton: correção por número e em frase", () => {
  it("'2 Maria Souza' corrige o item 2", async () => {
    const t = montar("2 Maria Souza");
    const passo = await conduzirV2(emRevisao(), t.ctx, t.deps);
    // Cartão primeiro, nada escrito.
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toMatch(/SIM/);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.lidosPendentes.map((l) => l.path)).toEqual(["vendedores[0].nome"]);
    // O SIM grava.
    const sim = montar("sim", {}, "wamid.SIMN");
    await conduzirV2(f, sim.ctx, sim.deps);
    const [verbo, corpo, chave] = escritas(sim.acao)[0] as [string, Record<string, unknown>, string];
    expect(verbo).toBe("proposal.update");
    expect(chave).toBe("wamid.SIMN");
    expect(corpo).toMatchObject({ vendedores: [{ nome: "Maria Souza" }] });
  });

  it("texto livre 'o CPF dela é…' também corrige", async () => {
    const t = montar(`o CPF dela é ${CPF}`, { compradores: [{ cpf: CPF_DIGITOS }] });
    const passo = await conduzirV2(emRevisao(), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toContain("***.982.247-**");
    expect(passo.reply).not.toContain(CPF_DIGITOS);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.lidosPendentes.map((l) => l.path)).toEqual(["compradores[0].cpf"]);
    expect(JSON.stringify(f)).not.toContain(CPF_DIGITOS);
    const sim = montar("sim", {}, "wamid.SIMC");
    await conduzirV2(f, sim.ctx, sim.deps);
    const [, corpo] = escritas(sim.acao)[0] as [string, Record<string, unknown>];
    expect(corpo).toMatchObject({ compradores: [{ cpf: CPF_DIGITOS }] });
  });

  it("'ok' ao cartão não grava no Newton também", async () => {
    const t = montar("2 Maria Souza");
    const p1 = await conduzirV2(emRevisao(), t.ctx, t.deps);
    const ok = montar("ok");
    await conduzirV2(p1.fluxo as FluxoFormularioV2, ok.ctx, ok.deps);
    expect(escritas(ok.acao)).toHaveLength(0);
  });

  it("o rascunho completo no Newton fecha como o C1 (revisão só sob pedido)", async () => {
    const f = emRevisao();
    const t = montar("sim");
    t.acao.mockImplementation(async (verb: string) => (verb === "proposal.options" ? { status: 200, body: options({ faltando: [] }) } : null));
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.reply).toMatch(/Rascunho completo/);
    expect(passo.fluxo).toBeNull();
    expect(escritas(t.acao)).toHaveLength(0);
  });
});
