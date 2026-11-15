import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conduzirV2 } from "../condutor";
import { novoFluxoV2, type FluxoFormularioV2 } from "../estado";
import { itensDaRevisao, lerCorrecaoNumerada, pedeRevisao, textoDaRevisao, TEXTO_CORRIJA_ASSIM, TEXTO_EDITAR_PELA_TELA } from "../revisao";
import { LIMITE_DA_FICHA } from "../ficha";
import type { OptionsV2 } from "../contrato";
import { consumirFlowDoTurno } from "../../../lib/meta-flow";
import type { ContextoDoTurno, DepsDoFluxo, RespostaDoServidor } from "../../fluxos";

/**
 * A revisão final do rascunho (PR-C2, T11/T12): lista numerada, correção por número, resposta do
 * Flow. Negados primeiro. Nada aqui grava sem o cartão e o SIM; "ok" e "blz" nunca valem SIM.
 * O config do Newton roda esta suíte com o perfil `newton`: o Max é fixado em cada caso.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const T0 = 1_800_000_000_000;
const THREAD = "thread-revisao";
const SUBJECT = JSON.stringify(["org-1", "u1"]);
const CPF = "529.982.247-25";
const CPF_DIGITOS = "52998224725";
const NONCE = "NONCE_DA_REVISAO";

const OBRIGATORIOS = [
  { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "proponente.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" },
  { chave: "contraparte.nome", rotulo: "Nome do vendedor", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
  { chave: "corretor.nome", rotulo: "Corretor", grupo: "Corretor", esteira: "venda", tipoCampo: "texto" },
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
    ...extra,
  };
}
const opcoesTipadas = (extra: Record<string, unknown> = {}): OptionsV2 => options(extra) as unknown as OptionsV2;

const falta = (campo: string) => ({ signatario: null, campo, motivo: "obrigatorio_da_org" });

interface Montagem {
  texto?: string;
  args?: Record<string, unknown> | null;
  optionsBody?: Record<string, unknown>;
  escrita?: RespostaDoServidor | null;
  messageId?: string;
  agora?: number;
  /** `button_payload` do turno (`flow:<token>` quando é resposta de Flow). */
  botao?: string | null;
}

function montar(m: Montagem = {}) {
  const texto = m.texto ?? "";
  const acao = vi.fn(async (verb: string, _args: Record<string, unknown>, _k?: string): Promise<RespostaDoServidor | null> => {
    if (verb === "proposal.options") return { status: 200, body: m.optionsBody ?? options({ faltando: [falta("negociacao.valor")] }) };
    if (verb === "proposal.create" || verb === "proposal.update") {
      if (m.escrita !== undefined) return m.escrita;
      return { status: 200, body: { proposta: { id: "prop-1", codigo: "PROP-1" }, faltando: [falta("negociacao.valor")] } };
    }
    return null;
  });
  const extrairComJanela = vi.fn(async () => (m.args === undefined ? {} : m.args));
  const pausa = { agendar: vi.fn(async () => undefined), cancelar: vi.fn(async () => undefined), entregue: vi.fn(async () => false) };
  const janelaDoTurno = vi.fn(() => ({ atual: texto, anteriores: [] as string[], lidos: [] as never[] }));
  const deps = { acao, extrairProposta: vi.fn(), extrairCampos: vi.fn(), janelaDoTurno, extrairComJanela, pausa } as unknown as DepsDoFluxo;
  const ctx: ContextoDoTurno = {
    texto,
    messageId: m.messageId ?? "wamid.1",
    policy: [],
    agora: m.agora ?? T0 + 5_000,
    thread: THREAD,
    subjectKey: SUBJECT,
    podeEscrever: true,
    botao: m.botao ?? null,
  };
  return { acao, extrairComJanela, pausa, deps, ctx };
}

const escritas = (acao: ReturnType<typeof montar>["acao"]) => acao.mock.calls.filter(([v]) => v === "proposal.create" || v === "proposal.update");

function salvo(extra: Partial<FluxoFormularioV2> = {}): FluxoFormularioV2 {
  return { ...novoFluxoV2({ esteira: "venda", agora: T0, schemaType: "compra_venda_v1" }), proposalId: "prop-1", etapa: "compor", ...extra };
}

/** Uma revisão já aberta nos itens do `options` de teste. */
function emRevisao(via: "flow" | "texto", passo: "partes" | "imovel_valor" = "partes", nonce = NONCE): FluxoFormularioV2 {
  return salvo({ etapa: "revisar", revisao: { passo, via, nonce, itens: itensDaRevisao(opcoesTipadas()) } });
}

/** O `button_payload` que o Meta grava quando o `flow_token` é o do Flow enviado (I1). */
const botaoDoFlow = (passo: "partes" | "imovel_valor" = "partes", nonce = NONCE) => `flow:fv2:${passo}:${nonce}`;

beforeEach(() => {
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
  vi.stubEnv("MAX_INTERACTIVE", "");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_IMOVEL_VALOR", "");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_ASSINATURA", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── A parte pura ───────────────────────────────────────────────────────────

describe("lista numerada (a parte pura)", () => {
  it("os itens vêm do obrigatorios[], na ordem, sem corretor", () => {
    expect(itensDaRevisao(opcoesTipadas())).toEqual(["compradores[0].nome", "compradores[0].cpf", "vendedores[0].nome", "negociacao.valor"]);
  });

  it("o item de parte se repete por parte que o rascunho já tem", () => {
    const duas = opcoesTipadas({ signatarios: [{ nome: "A", papel: "comprador" }, { nome: "B", papel: "comprador" }] });
    expect(itensDaRevisao(duas)).toEqual(["compradores[0].nome", "compradores[1].nome", "compradores[0].cpf", "compradores[1].cpf", "vendedores[0].nome", "negociacao.valor"]);
  });

  it("o texto é numerado, sem valor nem CPF, e cabe no limite", () => {
    const o = opcoesTipadas({ signatarios: [{ nome: "Maria Souza Lima", papel: "comprador" }] });
    const t = textoDaRevisao({ options: o, itens: itensDaRevisao(o), faltando: [falta("negociacao.valor") as never] });
    expect(t).toMatch(/^1\. Comprador 1 · Nome do comprador ✅$/m);
    expect(t).toMatch(/^4\. Valor da proposta ⬜$/m);
    expect(t).toContain(TEXTO_CORRIJA_ASSIM);
    expect(t).not.toContain("Maria Souza Lima");
    expect(t).not.toContain(CPF_DIGITOS);
    expect(t.length).toBeLessThanOrEqual(LIMITE_DA_FICHA);
  });

  it("muitos itens: corta em 'e mais N' e continua dentro do limite", () => {
    const muitos = Array.from({ length: 80 }, (_, i) => ({ chave: `imovel.campo_${i}`, rotulo: `Um rótulo bem comprido do campo número ${i}`, grupo: "Imóvel", esteira: "venda", tipoCampo: "texto" }));
    const o = opcoesTipadas({ obrigatorios: muitos });
    const t = textoDaRevisao({ options: o, itens: itensDaRevisao(o), faltando: null });
    expect(t.length).toBeLessThanOrEqual(LIMITE_DA_FICHA);
    expect(t).toMatch(/…e mais \d+ itens/);
  });

  it("a ficha nunca leva link: sempre o aviso fixo de abrir a proposta no sistema (I4/R20)", () => {
    const o = opcoesTipadas();
    const t = textoDaRevisao({ options: o, itens: itensDaRevisao(o), faltando: null });
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).toContain(TEXTO_EDITAR_PELA_TELA);
  });

  it("pedeRevisao: frase curta e inteira, nunca um trecho de dado", () => {
    for (const t of ["revisar", "Revisão", "revisar a proposta", "me mostra a revisão", "conferir", "quero revisar", "revisao da proposta"]) expect(pedeRevisao(t)).toBe(true);
    for (const t of ["", "sim", "ok", "o valor é 500 mil", "preciso revisar a minuta com o cliente amanhã de manhã", "revisar contrato do João", "o comprador quer revisar"]) expect(pedeRevisao(t)).toBe(false);
  });

  it("'2 Maria Souza' é o item 2; número fora da lista não é correção", () => {
    const o = opcoesTipadas();
    const itens = itensDaRevisao(o);
    const c = lerCorrecaoNumerada("3 João Pires", itens, o.obrigatorios);
    expect(c).toMatchObject({ tipo: "item", n: 3, path: "vendedores[0].nome" });
    expect(lerCorrecaoNumerada("3. João Pires", itens, o.obrigatorios)).toMatchObject({ tipo: "item", n: 3 });
    expect(lerCorrecaoNumerada("50 mil de sinal", itens, o.obrigatorios)).toEqual({ tipo: "nenhuma" });
    expect(lerCorrecaoNumerada("0 x", itens, o.obrigatorios)).toEqual({ tipo: "nenhuma" });
    expect(lerCorrecaoNumerada("2", itens, o.obrigatorios)).toEqual({ tipo: "nenhuma" });
    expect(lerCorrecaoNumerada("Maria Souza", itens, o.obrigatorios)).toEqual({ tipo: "nenhuma" });
  });

  it("o valor do item passa pela mesma validação: CPF com dígito errado é recusado", () => {
    const o = opcoesTipadas();
    const c = lerCorrecaoNumerada("2 111.111.111-11", itensDaRevisao(o), o.obrigatorios);
    expect(c).toMatchObject({ tipo: "item", leitura: { tipo: "invalida" } });
  });
});

// ─── No condutor ────────────────────────────────────────────────────────────

describe("negados: a revisão nunca grava sozinha", () => {
  it("sem rascunho salvo, 'revisar' não abre revisão", async () => {
    const t = montar({ texto: "revisar" });
    const passo = await conduzirV2({ ...novoFluxoV2({ esteira: "venda", agora: T0, schemaType: "compra_venda_v1" }) }, t.ctx, t.deps);
    expect((passo.fluxo as FluxoFormularioV2 | null)?.revisao).toBeUndefined();
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("correção numerada só vira cartão: nada é escrito antes do SIM", async () => {
    const t = montar({ texto: "3 João Pires" });
    const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect((passo.fluxo as FluxoFormularioV2).etapa).toBe("ficha");
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes.map((l) => l.path)).toEqual(["vendedores[0].nome"]);
  });

  it("'ok' e 'blz' não são SIM: o cartão fica esperando e nada é escrito", async () => {
    const t1 = montar({ texto: "3 João Pires" });
    const p1 = await conduzirV2(emRevisao("texto"), t1.ctx, t1.deps);
    for (const fala of ["ok", "blz", "beleza", "certo"]) {
      const t = montar({ texto: fala, messageId: `wamid.${fala}` });
      const p = await conduzirV2(p1.fluxo as FluxoFormularioV2, t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect((p.fluxo as FluxoFormularioV2 | null)?.lidosPendentes.length).toBe(1);
    }
  });

  it("'ok' numa revisão sem nada pendente não avança nem encerra", async () => {
    const t = montar({ texto: "ok" });
    const passo = await conduzirV2(emRevisao("flow"), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply ?? "").not.toMatch(/Revisão concluída|completo/);
    expect((passo.fluxo as FluxoFormularioV2 | null)?.revisao?.passo).toBe("partes");
  });

  it("'não' encerra a revisão sem escrever e sem apagar o rascunho", async () => {
    const t = montar({ texto: "não" });
    const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/parei a revisão/i);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.revisao).toBeUndefined();
    expect(f.proposalId).toBe("prop-1");
  });

  it("cancelar sai de qualquer revisão", async () => {
    const t = montar({ texto: "cancelar" });
    const passo = await conduzirV2(emRevisao("flow"), t.ctx, t.deps);
    expect(passo.fluxo).toBeNull();
    expect(escritas(t.acao)).toHaveLength(0);
  });
});

describe("abrir a revisão: Flow só com flag, id e Max", () => {
  it("sem MAX_FLOW_ID_* cai na lista numerada (via texto), sem Flow no canal lateral", async () => {
    const t = montar({ texto: "revisar", messageId: "wamid.REV0" });
    const passo = await conduzirV2(salvo(), t.ctx, t.deps);
    expect(passo.reply).toMatch(/^1\. Comprador 1 · Nome do comprador/m);
    expect(passo.reply).not.toContain("Toque em *Revisar*");
    expect(consumirFlowDoTurno("wamid.REV0")).toBeUndefined();
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.etapa).toBe("revisar");
    expect(f.revisao).toMatchObject({ passo: "partes", via: "texto" });
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("com o id do passo, o Max manda o Flow, com a ficha numerada de corpo", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    const t = montar({ texto: "revisar", messageId: "wamid.REV1" });
    const passo = await conduzirV2(salvo(), t.ctx, t.deps);
    const flow = consumirFlowDoTurno("wamid.REV1");
    const rev = (passo.fluxo as FluxoFormularioV2).revisao;
    // O token amarra a resposta ao envio: fv2:<passo>:<nonce>, com o nonce guardado na revisão (não é PII).
    expect(rev?.nonce).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(flow).toMatchObject({ tipo: "flow", flowId: "FLOW_PARTES", flowToken: `fv2:partes:${rev?.nonce}`, screen: "PARTE_1" });
    expect(passo.reply).toMatch(/^1\. Comprador 1 · Nome do comprador/m);
    // Oferecer o Flow não prova que ele chegou: `via` só vira "flow" quando uma resposta com o token volta.
    expect(rev).toMatchObject({ passo: "partes", via: "texto" });
    // O checkpoint não carrega nome nem CPF.
    expect(JSON.stringify(passo.fluxo)).not.toContain(CPF_DIGITOS);
  });

  it("com o id mas MAX_INTERACTIVE=off: cai na lista numerada", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    vi.stubEnv("MAX_INTERACTIVE", "off");
    const t = montar({ texto: "revisar", messageId: "wamid.REV2" });
    const passo = await conduzirV2(salvo(), t.ctx, t.deps);
    expect(consumirFlowDoTurno("wamid.REV2")).toBeUndefined();
    expect((passo.fluxo as FluxoFormularioV2).revisao?.via).toBe("texto");
  });

  it("com o id mas perfil Newton: nunca Flow", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    const t = montar({ texto: "revisar", messageId: "wamid.REV3" });
    const passo = await conduzirV2(salvo(), t.ctx, t.deps);
    expect(consumirFlowDoTurno("wamid.REV3")).toBeUndefined();
    expect((passo.fluxo as FluxoFormularioV2).revisao?.via).toBe("texto");
  });

  it("pedido de revisão com algo esperando o SIM mostra o cartão primeiro", async () => {
    const t1 = montar({ texto: "3 João Pires" });
    const p1 = await conduzirV2(emRevisao("texto"), t1.ctx, t1.deps);
    const t2 = montar({ texto: "revisar" });
    const p2 = await conduzirV2(p1.fluxo as FluxoFormularioV2, t2.ctx, t2.deps);
    expect(p2.reply).toContain("📋");
    expect(escritas(t2.acao)).toHaveLength(0);
  });
});

describe("resposta do Flow: mesma validação, cartão e SIM", () => {
  const RESPOSTA = `compradores_0__nome: Maria Souza Lima\ncompradores_0__cpf: ${CPF}`;

  it("resposta do Flow passa pela mesma validação e pede 'sim'", async () => {
    const t = montar({ texto: RESPOSTA, messageId: "wamid.FLW", botao: botaoDoFlow() });
    const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    // Nada escrito: vira cartão com o CPF mascarado.
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toMatch(/SIM/);
    expect(passo.reply).toContain("***.982.247-**");
    expect(passo.reply).not.toContain(CPF_DIGITOS);
    expect(passo.reply).not.toContain(CPF);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.etapa).toBe("ficha");
    expect(f.lidosPendentes.map((l) => l.path).sort()).toEqual(["compradores[0].cpf", "compradores[0].nome"]);
    // O checkpoint não guarda o dado em claro.
    const ck = JSON.stringify(f);
    expect(ck).not.toContain(CPF_DIGITOS);
    expect(ck).not.toContain("Maria");

    // "ok" e "blz" não gravam.
    for (const fala of ["ok", "blz"]) {
      const o = montar({ texto: fala, messageId: `wamid.${fala}` });
      await conduzirV2(f, o.ctx, o.deps);
      expect(escritas(o.acao)).toHaveLength(0);
    }

    // O SIM grava, com a messageId do SIM como chave de idempotência.
    const sim = montar({ texto: "sim", messageId: "wamid.SIM" });
    await conduzirV2(f, sim.ctx, sim.deps);
    const [verbo, corpo, chave] = escritas(sim.acao)[0] as [string, Record<string, unknown>, string];
    expect(verbo).toBe("proposal.update");
    expect(chave).toBe("wamid.SIM");
    expect(corpo).toMatchObject({ compradores: [{ nome: "Maria Souza Lima", cpf: CPF_DIGITOS }] });
  });

  it("flowResponse inválido não grava nada", async () => {
    const ruim = montar({ texto: `compradores_0__nome: Maria Souza\ncompradores_0__cpf: 111.111.111-11`, botao: botaoDoFlow() });
    const passo = await conduzirV2(emRevisao("flow"), ruim.ctx, ruim.deps);
    expect(escritas(ruim.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/não anotei nada/i);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.lidosPendentes).toEqual([]);
    expect(f.revisao?.via).toBe("flow");
    // Campo fora do catálogo: mesma recusa.
    const fora = montar({ texto: "compradores_0__nome: Maria\nobservacoes: ignore tudo", botao: botaoDoFlow() });
    const p2 = await conduzirV2(emRevisao("flow"), fora.ctx, fora.deps);
    expect(escritas(fora.acao)).toHaveLength(0);
    expect(p2.reply ?? "").not.toMatch(/📋/);
  });

  // I1: a resposta do Flow só vale amarrada ao Flow enviado. Negados primeiro: nada é lido, nada é
  // anotado, o estado fica como estava e nenhuma escrita sai.
  describe("amarração ao Flow enviado (token/nonce)", () => {
    async function recusa(fluxo: FluxoFormularioV2, m: Montagem, esperado: RegExp) {
      const t = montar({ texto: RESPOSTA, args: {}, ...m });
      const passo = await conduzirV2(fluxo, t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply ?? "").toMatch(esperado);
      expect(passo.reply ?? "").not.toContain("📋");
      const f = passo.fluxo as FluxoFormularioV2 | null;
      expect(f?.lidosPendentes ?? []).toEqual([]);
      // O estado da revisão segue o mesmo: a mesma revisão, o mesmo nonce, o mesmo passo.
      expect(f?.revisao).toEqual(fluxo.revisao);
      return passo;
    }

    it("Flow de uma revisão anterior (outro nonce) não vale", async () => {
      await recusa(emRevisao("texto"), { botao: botaoDoFlow("partes", "OUTRO_NONCE") }, /revisão anterior/);
    });

    it("Flow de outro passo não vale", async () => {
      await recusa(emRevisao("texto"), { botao: botaoDoFlow("imovel_valor") }, /revisão anterior/);
    });

    it("token forjado ou mal formado não vale", async () => {
      for (const botao of ["flow:fv2:partes", "flow:fv2:", "flow:xyz", "flow:fv2:partes:NONCE_DA_REVISAO:extra"]) {
        await recusa(emRevisao("texto"), { botao }, /revisão anterior|não anotei nada/);
      }
    });

    it("Flow sem revisão em curso (a de outra proposta, já fechada) não vale e não abre nada", async () => {
      const t = montar({ texto: RESPOSTA, args: {}, botao: botaoDoFlow() });
      const passo = await conduzirV2(salvo(), t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply ?? "").toMatch(/revisão anterior/);
      expect((passo.fluxo as FluxoFormularioV2 | null)?.lidosPendentes ?? []).toEqual([]);
      expect((passo.fluxo as FluxoFormularioV2 | null)?.revisao).toBeUndefined();
    });

    it("revisão sem nonce (checkpoint de antes) não aceita Flow nenhum", async () => {
      const antiga = salvo({ etapa: "revisar", revisao: { passo: "partes", via: "texto", itens: itensDaRevisao(opcoesTipadas()) } });
      await recusa(antiga, { botao: botaoDoFlow() }, /revisão anterior/);
    });

    it("texto digitado com cara de Flow, sem token, não é lido como Flow", async () => {
      vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
      await recusa(emRevisao("texto"), {}, /não veio do formulário/);
      await recusa(emRevisao("flow"), {}, /não veio do formulário/);
    });

    it("sem Flow configurado, o texto com cara de Flow é texto comum (como no C1)", async () => {
      const t = montar({ texto: RESPOSTA, args: {} });
      const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply ?? "").not.toMatch(/não veio do formulário|revisão anterior/);
    });

    it("texto digitado sem revisão em curso segue o caminho normal (o modelo só vê dado)", async () => {
      const t = montar({ texto: RESPOSTA, args: {} });
      const passo = await conduzirV2(salvo(), t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply ?? "").not.toMatch(/revisão anterior/);
    });

    it("nenhum caminho do Flow (aceito ou recusado) escreve CPF, nome ou token em log", async () => {
      vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
      const espioes = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      const casos: Array<[FluxoFormularioV2, Montagem]> = [
        [emRevisao("texto"), { botao: botaoDoFlow() }],
        [emRevisao("texto"), { botao: botaoDoFlow("partes", "OUTRO") }],
        [emRevisao("texto"), {}],
        [salvo(), { botao: botaoDoFlow() }],
      ];
      for (const [fluxo, m] of casos) {
        const t = montar({ texto: RESPOSTA, args: {}, ...m });
        await conduzirV2(fluxo, t.ctx, t.deps);
      }
      const saida = espioes.flatMap((e) => e.mock.calls.map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))).join("\n");
      for (const dado of [CPF, CPF_DIGITOS, "Maria Souza", NONCE, "OUTRO"]) expect(saida).not.toContain(dado);
    });

    it("com o token certo a resposta vira cartão; o SIM é o que grava", async () => {
      const t = montar({ texto: RESPOSTA, botao: botaoDoFlow() });
      const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply).toContain("📋");
      const f = passo.fluxo as FluxoFormularioV2;
      expect(f.revisao).toMatchObject({ via: "flow", nonce: NONCE });
    });
  });

  // I2: o Flow devolve todos os campos pré-preenchidos; o que não mudou não é correção.
  describe("Flow sem pré-preenchimento posicional", () => {
    it("signatários em outra ordem não viram nome pré-preenchido: o SIM grava só o corrigido", async () => {
      // Rascunho com 2 compradores em que só o 2º assina: `signatarios` não é a lista posicional.
      const o = { optionsBody: options({ signatarios: [{ nome: "Segundo Comprador", papel: "comprador" }], faltando: [] }) };
      const t = montar({ texto: "compradores_0__cpf: " + CPF, botao: botaoDoFlow(), ...o });
      const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
      const f = passo.fluxo as FluxoFormularioV2;
      expect(f.lidosPendentes.map((l) => l.path)).toEqual(["compradores[0].cpf"]);
      const sim = montar({ texto: "sim", messageId: "wamid.SIMPOS", ...o });
      await conduzirV2(f, sim.ctx, sim.deps);
      const [, corpo] = escritas(sim.acao)[0] as [string, Record<string, unknown>];
      expect(corpo).toEqual({ proposta_id: "prop-1", compradores: [{ cpf: CPF_DIGITOS }] });
      expect(JSON.stringify(corpo)).not.toContain("Segundo Comprador");
    });
  });

  it("depois do SIM da correção, via Flow segue para o passo seguinte", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_IMOVEL_VALOR", "FLOW_IMOVEL");
    const t = montar({ texto: RESPOSTA, messageId: "wamid.FLW", botao: botaoDoFlow() });
    const p1 = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    const sim = montar({ texto: "sim", messageId: "wamid.SIM2" });
    const p2 = await conduzirV2(p1.fluxo as FluxoFormularioV2, sim.ctx, sim.deps);
    expect(escritas(sim.acao)).toHaveLength(1);
    const flow = consumirFlowDoTurno("wamid.SIM2");
    const rev2 = (p2.fluxo as FluxoFormularioV2).revisao;
    expect(rev2?.nonce).toBeTruthy();
    expect(rev2?.nonce).not.toBe(NONCE);
    expect(flow).toMatchObject({ flowId: "FLOW_IMOVEL", screen: "IMOVEL_VALOR", flowToken: `fv2:imovel_valor:${rev2?.nonce}` });
    expect(rev2).toMatchObject({ passo: "imovel_valor", via: "texto" });
  });

  it("se o Flow foi oferecido mas ninguém respondeu por ele (via texto), o SIM conclui em vez de avançar", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_IMOVEL_VALOR", "FLOW_IMOVEL");
    const t = montar({ texto: "3 João Pires" });
    const p1 = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    const sim = montar({ texto: "sim", messageId: "wamid.SIM2B" });
    const p2 = await conduzirV2(p1.fluxo as FluxoFormularioV2, sim.ctx, sim.deps);
    expect(escritas(sim.acao)).toHaveLength(1);
    expect(consumirFlowDoTurno("wamid.SIM2B")).toBeUndefined();
    expect((p2.fluxo as FluxoFormularioV2).revisao).toMatchObject({ passo: "partes", via: "texto" });
  });
});

describe("correção por texto (Max, sem Flow)", () => {
  it("'3 João Pires' corrige o item 3 e, depois do SIM, a lista volta", async () => {
    const t = montar({ texto: "3 João Pires" });
    const p1 = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    const sim = montar({ texto: "sim", messageId: "wamid.SIM3" });
    const p2 = await conduzirV2(p1.fluxo as FluxoFormularioV2, sim.ctx, sim.deps);
    const [, corpo] = escritas(sim.acao)[0] as [string, Record<string, unknown>];
    expect(corpo).toMatchObject({ vendedores: [{ nome: "João Pires" }] });
    expect(p2.reply).toMatch(/^1\. Comprador 1 · Nome do comprador/m);
    expect((p2.fluxo as FluxoFormularioV2).revisao).toMatchObject({ passo: "partes", via: "texto" });
  });

  it("CPF com dígito errado no item não vira cartão nem escrita", async () => {
    const t = montar({ texto: "2 111.111.111-11" });
    const passo = await conduzirV2(emRevisao("texto"), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes).toEqual([]);
    expect(passo.reply).not.toContain("📋");
  });
});

describe("rascunho completo", () => {
  const PEND = [{ path: "compradores[0].nome", valor: "Maria Souza Lima", confianca: 0.9 }];
  const completo = { status: 201, body: { proposal: { id: "prop-1", codigo: "PROP-1" }, faltando: [] } } as RespostaDoServidor;

  async function simAoCartao() {
    const { registrarLidos } = await import("../midia");
    const f0 = { ...novoFluxoV2({ esteira: "venda", agora: T0, schemaType: "compra_venda_v1" }), etapa: "ficha" as const };
    const r = registrarLidos(f0, { ref: "txt:wamid.0", campos: PEND }, THREAD);
    if (!r.ok) throw new Error("registrarLidos falhou");
    return { ...r.fluxo, etapa: "ficha" as const };
  }

  it("sem Flow configurado o completo é o do C1, byte a byte (fluxo null, sem revisão)", async () => {
    const t = montar({ texto: "sim", messageId: "wamid.SIMC", escrita: completo, optionsBody: options({ faltando: [] }) });
    const passo = await conduzirV2(await simAoCartao(), t.ctx, t.deps);
    // A string inteira, igual à do C1 (`f96c250`): a prova de "byte a byte" não é um trecho.
    expect(passo.reply).toBe('Anotei e salvei no rascunho PROP-1.\nRascunho PROP-1 completo. Para enviar para assinatura, peça "enviar PROP-1 para assinatura".');
    expect(passo.fluxo).toBeNull();
    expect(consumirFlowDoTurno("wamid.SIMC")).toBeUndefined();
  });

  it("no Newton o completo é o do C1 mesmo com o id do Flow configurado", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    const t = montar({ texto: "sim", messageId: "wamid.SIMN", escrita: completo, optionsBody: options({ faltando: [] }) });
    const passo = await conduzirV2(await simAoCartao(), t.ctx, t.deps);
    expect(passo.fluxo).toBeNull();
    expect(passo.reply).not.toMatch(/Revisão da proposta/);
    expect(consumirFlowDoTurno("wamid.SIMN")).toBeUndefined();
  });

  it("no Max com Flow, o completo abre a revisão pelo Flow", async () => {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
    const t = montar({ texto: "sim", messageId: "wamid.SIMF", escrita: completo, optionsBody: options({ faltando: [] }) });
    const passo = await conduzirV2(await simAoCartao(), t.ctx, t.deps);
    expect(passo.reply).toMatch(/Rascunho PROP-1 completo/);
    expect(passo.reply).toMatch(/Revisão da proposta/);
    const rev = (passo.fluxo as FluxoFormularioV2).revisao;
    expect(consumirFlowDoTurno("wamid.SIMF")).toMatchObject({ flowId: "FLOW_PARTES", flowToken: `fv2:partes:${rev?.nonce}` });
    expect(rev).toMatchObject({ passo: "partes", via: "texto" });
  });

  it("revisão via Flow no último passo, sem nada pendente, conclui como o C1", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ faltando: [] }) });
    const f = emRevisao("flow", "imovel_valor");
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.reply).toMatch(/Rascunho completo/);
    expect(passo.fluxo).toBeNull();
    expect(escritas(t.acao)).toHaveLength(0);
  });
});
