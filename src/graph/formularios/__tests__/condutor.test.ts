import { afterEach, describe, expect, it, vi } from "vitest";
import { conduzirV2 } from "../condutor";
import { novoFluxoV2, type FluxoFormularioV2 } from "../estado";
import { lidosDoCofre, registrarLidos, type CampoLido } from "../midia";
import { PAUSA_DA_FICHA_MS } from "../pausa";
import type { ContextoDoTurno, DepsDoFluxo, RespostaDoServidor } from "../../fluxos";
import { TEXTO_ESCRITA_INCERTA, rebaixarFluxo } from "../../fluxos";

/**
 * O condutor v2 (PR-C1): coleta em silêncio, ficha na pausa de 20 s, "sim" grava.
 * Negados primeiro (feature OFF, servidor OFF, cancelar), depois os permitidos.
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const T0 = 1_800_000_000_000;
const THREAD = "thread-condutor";
const SUBJECT = JSON.stringify(["org-1", "u1"]);
const CPF = "529.982.247-25";
const CPF_DIGITOS = "52998224725";

const OBRIGATORIOS = [
  { chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" },
  { chave: "proponente.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" },
  { chave: "negociacao.valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
] as const;

function options(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }],
    signatarios: [],
    assinaturaConfigurada: true,
    modalidades: [{ schemaType: "compra_venda_v1", esteira: "venda", rotulo: "Compra e venda", modeloDisponivel: true }],
    obrigatorios: OBRIGATORIOS,
    tiposDeAssinatura: [],
    fluxoV2: true,
    ...extra,
  };
}

const falta = (campo: string) => ({ signatario: null, campo, motivo: "obrigatorio_da_org" });

interface Montagem {
  texto?: string;
  args?: Record<string, unknown> | null;
  optionsBody?: Record<string, unknown> | null;
  /** Resposta crua do `proposal.options` (status != 200). Vence `optionsBody`. */
  optionsResposta?: RespostaDoServidor;
  escrita?: RespostaDoServidor | null;
  semJanela?: boolean;
  semPausa?: boolean;
  /** A ficha agendada (dedupeKey) já saiu pelo outbox (`sent`)? Padrão: não. */
  entregue?: boolean;
  /** Sem o método `entregue` nas deps da pausa (fila antiga): nunca vale como vista. */
  semEntregue?: boolean;
  agora?: number;
  podeEscrever?: boolean;
  messageId?: string;
}

function montar(m: Montagem = {}) {
  const texto = m.texto ?? "";
  const acao = vi.fn(async (verb: string, _args: Record<string, unknown>, _k?: string): Promise<RespostaDoServidor | null> => {
    if (verb === "proposal.options") {
      if (m.optionsResposta) return m.optionsResposta;
      return m.optionsBody === null ? null : { status: 200, body: m.optionsBody ?? options() };
    }
    if (verb === "proposal.create" || verb === "proposal.update") {
      if (m.escrita !== undefined) return m.escrita;
      return {
        status: verb === "proposal.create" ? 201 : 200,
        body: {
          ...(verb === "proposal.create" ? { proposal: { id: "prop-1", codigo: "PROP-1" } } : { proposta: { id: "prop-1", codigo: "PROP-1" } }),
          faltando: [falta("negociacao.valor")],
        },
      };
    }
    return null;
  });
  const extrairComJanela = vi.fn(async () => (m.args === undefined ? {} : m.args));
  const pausa = {
    agendar: vi.fn(async () => undefined),
    cancelar: vi.fn(async () => undefined),
    entregue: vi.fn(async (_dedupeKey: string) => m.entregue === true),
  };
  const janelaDoTurno = vi.fn((_anteriores: number) => ({ atual: texto, anteriores: [] as string[], lidos: [] as never[] }));
  const deps = {
    acao,
    extrairProposta: vi.fn(),
    extrairCampos: vi.fn(),
    ...(m.semJanela ? {} : { janelaDoTurno, extrairComJanela }),
    ...(m.semPausa ? {} : { pausa: m.semEntregue ? { agendar: pausa.agendar, cancelar: pausa.cancelar } : pausa }),
  } as unknown as DepsDoFluxo;
  const ctx: ContextoDoTurno = {
    texto,
    messageId: m.messageId ?? "wamid.1",
    policy: [],
    agora: m.agora ?? T0 + 5_000,
    thread: THREAD,
    subjectKey: SUBJECT,
    podeEscrever: m.podeEscrever ?? true,
  };
  return { acao, extrairComJanela, janelaDoTurno, pausa, deps, ctx };
}

const L = (path: string, valor: string): CampoLido => ({ path, valor, confianca: 0.9 });
/** Resposta a uma pergunta do Max sobre um campo exato (a posição vem do `faltando` do servidor). */
const LP = (path: string, valor: string): CampoLido => ({ ...L(path, valor), perguntado: true });

function fluxoBase(extra: Partial<FluxoFormularioV2> = {}): FluxoFormularioV2 {
  return { ...novoFluxoV2({ esteira: "venda", agora: T0, schemaType: "compra_venda_v1" }), ...extra };
}

function comPendentes(campos: CampoLido[], extra: Partial<FluxoFormularioV2> = {}): FluxoFormularioV2 {
  const r = registrarLidos(fluxoBase(extra), { ref: "txt:wamid.0", campos }, THREAD);
  if (!r.ok) throw new Error("registrarLidos falhou");
  return { ...r.fluxo, ...extra };
}

const escritas = (acao: ReturnType<typeof montar>["acao"]) =>
  acao.mock.calls.filter(([v]) => v === "proposal.create" || v === "proposal.update");

afterEach(() => vi.restoreAllMocks());

describe("negados: o condutor nunca escreve nem fala fora do que está ligado", () => {
  it("feature OFF (sem os métodos da janela): libera e limpa, sem tocar o servidor nem a fila", async () => {
    const t = montar({ semJanela: true, texto: "oi" });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo).toMatchObject({ liberar: true, fluxo: null, evento: "fluxo_v2_desligado" });
    expect(t.acao).not.toHaveBeenCalled();
    expect(t.pausa.agendar).not.toHaveBeenCalled();
  });

  it("servidor com a flag desligada (fluxoV2 false): libera; com rascunho, o v1 retoma o que já existe", async () => {
    const t = montar({ texto: "oi", optionsBody: options({ fluxoV2: false }) });
    const sem = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(sem).toMatchObject({ liberar: true, fluxo: null, evento: "fluxo_v2_desligado" });
    const com = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), t.ctx, t.deps);
    expect(com).toMatchObject({ liberar: true, evento: "fluxo_v2_desligado", fluxo: { kind: "proposta", etapa: "ajustes", propostaId: "prop-1" } });
    expect(t.extrairComJanela).not.toHaveBeenCalled();
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("servidor sem resposta no options e o turno é do fluxo (SIM com pendentes): avisa, mantém o fluxo, não extrai nem escreve", async () => {
    const t = montar({ texto: "sim", optionsBody: null });
    const passo = await conduzirV2(comPendentes([L("compradores[0].nome", "Maria Souza Lima")], { etapa: "ficha" }), t.ctx, t.deps);
    expect(passo.liberar).not.toBe(true);
    expect(passo.reply).toMatch(/sistema/i);
    expect(passo.fluxo).toMatchObject({ kind: "proposta_v2", mensagensDoFluxo: 1 });
    expect(t.extrairComJanela).not.toHaveBeenCalled();
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("servidor sem resposta no options e o turno NÃO é do fluxo: libera e mantém o fluxo (sem 'sistema fora do ar' à toa)", async () => {
    const t = montar({ texto: "bom dia, tudo bem?", optionsBody: null });
    const passo = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), t.ctx, t.deps);
    expect(passo.liberar).toBe(true);
    expect(passo.reply).toBeUndefined();
    expect(passo.fluxo).toMatchObject({ kind: "proposta_v2", proposalId: "prop-1", mensagensDoFluxo: 1 });
    expect(t.extrairComJanela).not.toHaveBeenCalled();
  });

  it("options 400 sem alvo (servidor não conhece o fluxo): libera o turno e solta o fluxo, sem texto de sistema", async () => {
    const t = montar({ texto: "oi", optionsResposta: { status: 400, body: { error: "alvo_obrigatorio" } } });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo).toMatchObject({ liberar: true, fluxo: null, evento: "fluxo_v2_desligado" });
    expect(passo.reply).toBeUndefined();
    expect(t.pausa.cancelar).toHaveBeenCalled();
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("options 403 fluxo_desligado: libera; com rascunho o v1 retoma", async () => {
    const resp = { status: 403, body: { error: "fluxo_desligado" } };
    const t = montar({ texto: "sim", optionsResposta: resp });
    expect(await conduzirV2(fluxoBase(), t.ctx, t.deps)).toMatchObject({ liberar: true, fluxo: null, evento: "fluxo_v2_desligado" });
    const com = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), t.ctx, t.deps);
    expect(com).toMatchObject({ liberar: true, fluxo: { kind: "proposta", propostaId: "prop-1" } });
  });

  it("cancelar: encerra, cancela a ficha agendada, limpa o cofre e diz a verdade sobre o rascunho", async () => {
    const t = montar({ texto: "cancela" });
    const f = comPendentes([L("compradores[0].nome", "Maria Souza Lima")], { proposalId: "prop-1" });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.fluxo).toBeNull();
    expect(passo.reply).toMatch(/continua salvo/i);
    expect(passo.reply).not.toMatch(/nada foi criado/i);
    expect(t.pausa.cancelar).toHaveBeenCalledTimes(1);
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("cancelar antes de existir rascunho: nada foi criado", async () => {
    const t = montar({ texto: "cancela" });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo.fluxo).toBeNull();
    expect(passo.reply).toMatch(/nada foi criado/i);
  });

  it("'ok', '👍' e 'blz' não valem como SIM: nada é gravado e a ficha é mostrada", async () => {
    for (const texto of ["ok", "👍", "blz"]) {
      const t = montar({ texto });
      const f = comPendentes([L("compradores[0].nome", "Maria Souza Lima")], { etapa: "ficha" });
      const passo = await conduzirV2(f, t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.liberar).not.toBe(true);
    }
  });

  it("SIM sem permissão de escrita: texto de permissão, nenhuma escrita, pendentes descartados", async () => {
    const t = montar({ texto: "sim", podeEscrever: false });
    const f = comPendentes([L("compradores[0].nome", "Maria Souza Lima")], { etapa: "ficha" });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/permiss/i);
  });
});

describe("coleta em silêncio e a pausa de 20 s (T10, D2)", () => {
  const ARGS = { compradores: [{ nome: "Maria Souza Lima", cpf: CPF_DIGITOS }] };
  const TEXTO = `Comprador Maria Souza Lima CPF ${CPF}`;

  it("dado dentro dos 20 s: turno silencioso, ficha agendada, nada escrito, checkpoint sem PII", async () => {
    const t = montar({ texto: TEXTO, args: ARGS });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo).toMatchObject({ silencioso: true, reply: "" });
    expect(escritas(t.acao)).toHaveLength(0);
    expect(t.pausa.agendar).toHaveBeenCalledTimes(1);
    const agendado = (t.pausa.agendar.mock.calls[0] as unknown as [{ texto: string }])[0];
    expect(agendado.texto).not.toContain(CPF_DIGITOS);
    expect(agendado.texto).toContain("***.982.247-**");
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.etapa).toBe("compor");
    expect(f.lidosPendentes.map((l) => l.path).sort()).toEqual(["compradores[0].cpf", "compradores[0].nome"]);
    const checkpoint = JSON.stringify(f);
    expect(checkpoint).not.toContain(CPF_DIGITOS);
    expect(checkpoint).not.toContain("Maria");
    expect(f.fichaAgendadaEm).toBe(f.ultimaEntradaEm + PAUSA_DA_FICHA_MS);
    expect(f.mensagensDoFluxo).toBe(1);
  });

  it("sem fila de pausa o turno não fica mudo: mostra a ficha agora", async () => {
    const t = montar({ texto: TEXTO, args: ARGS, semPausa: true });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo.reply).toContain("📋");
    expect((passo as { silencioso?: boolean }).silencioso).toBeUndefined();
    expect((passo.fluxo as FluxoFormularioV2).etapa).toBe("ficha");
  });

  it("20 s depois da última entrada: mostra a ficha (📄 lido, conferir) e cancela a agendada", async () => {
    const t = montar({ texto: TEXTO, args: ARGS, agora: T0 + PAUSA_DA_FICHA_MS + 1 });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toContain("📄");
    expect(passo.reply).not.toContain(CPF_DIGITOS);
    expect(passo.reply).toMatch(/SIM/);
    expect((passo.fluxo as FluxoFormularioV2).etapa).toBe("ficha");
    expect(t.pausa.cancelar).toHaveBeenCalled();
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("'o que falta?' força a ficha, sem pagar extração", async () => {
    const t = montar({ texto: "o que falta?" });
    const f = comPendentes([L("compradores[0].nome", "Maria Souza Lima")]);
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toContain("⬜");
    expect(t.extrairComJanela).not.toHaveBeenCalled();
  });

  it("tudo numa mensagem (nada mais faltando): a ficha sai no mesmo turno", async () => {
    const t = montar({
      texto: `${TEXTO} valor 500 mil`,
      args: { ...ARGS, negociacao: { valor: 500000 } },
    });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo.reply).toContain("📋");
    expect(passo.reply).toMatch(/Rascunho|SIM/);
    expect((passo as { silencioso?: boolean }).silencioso).toBeUndefined();
  });

  it("mídia lida neste turno (ref = esta mensagem): ficha no mesmo turno", async () => {
    const t = montar({ texto: "segue o RG", args: {}, messageId: "wamid.MIDIA" });
    const r = registrarLidos(fluxoBase(), { ref: "wamid.MIDIA", campos: [L("compradores[0].nome", "Maria Souza Lima")] }, THREAD);
    if (!r.ok) throw new Error("falhou");
    const passo = await conduzirV2(r.fluxo, t.ctx, t.deps);
    expect(passo.reply).toContain("📋");
  });

  it("a resposta ao campo perguntado vira pendente sem chamar o modelo", async () => {
    const t = montar({ texto: CPF });
    const f = fluxoBase({ aguardaCampo: { parteRef: "proponente", path: "compradores[0].cpf" } });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(t.extrairComJanela).not.toHaveBeenCalled();
    const novo = passo.fluxo as FluxoFormularioV2;
    expect(novo.lidosPendentes.map((l) => l.path)).toContain("compradores[0].cpf");
    expect(lidosDoCofre(novo, THREAD).some((c) => c.valor.replace(/\D/g, "") === CPF_DIGITOS)).toBe(true);
  });

  it("resposta inválida ao campo pede de novo, sem anotar nada", async () => {
    const t = montar({ texto: "111.111.111-11" });
    const f = fluxoBase({ aguardaCampo: { parteRef: "proponente", path: "compradores[0].cpf" } });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.liberar).not.toBe(true);
    expect(passo.reply).toMatch(/CPF/i);
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes).toEqual([]);
  });

  it("sem MAX_ENCRYPTION_KEY nada vai ao checkpoint: diz que não guardou", async () => {
    const guardada = process.env.MAX_ENCRYPTION_KEY;
    delete process.env.MAX_ENCRYPTION_KEY;
    try {
      const t = montar({ texto: TEXTO, args: ARGS });
      const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
      expect(passo.reply).toMatch(/seguran/i);
      expect(JSON.stringify(passo.fluxo)).not.toContain(CPF_DIGITOS);
      expect((passo.fluxo as FluxoFormularioV2).lidosPendentes).toEqual([]);
    } finally {
      process.env.MAX_ENCRYPTION_KEY = guardada;
    }
  });

  it("conversa fora do assunto sem nada pendente: libera e encerra o fluxo vazio", async () => {
    const t = montar({ texto: "qual a previsão do tempo amanhã?", args: {} });
    const passo = await conduzirV2(fluxoBase(), t.ctx, t.deps);
    expect(passo).toMatchObject({ liberar: true, fluxo: null });
  });

  it("conversa fora do assunto com rascunho: libera e MANTÉM o fluxo", async () => {
    const t = montar({ texto: "qual a previsão do tempo amanhã?", args: {} });
    const passo = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), t.ctx, t.deps);
    expect(passo.liberar).toBe(true);
    expect(passo.fluxo).toMatchObject({ kind: "proposta_v2", proposalId: "prop-1" });
  });
});

describe("o SIM grava (e só ele)", () => {
  const PEND = [L("compradores[0].nome", "Maria Souza Lima"), L("compradores[0].cpf", CPF_DIGITOS)];

  it("SIM ao cartão: proposal.create com a messageId do SIM como idempotencyKey; pergunta o que falta", async () => {
    const t = montar({ texto: "sim", messageId: "wamid.SIM" });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha" }), t.ctx, t.deps);
    const [verbo, corpo, chave] = escritas(t.acao)[0] as [string, Record<string, unknown>, string];
    expect(verbo).toBe("proposal.create");
    expect(chave).toBe("wamid.SIM");
    expect(corpo).toMatchObject({ schemaType: "compra_venda_v1", compradores: [{ nome: "Maria Souza Lima", cpf: CPF_DIGITOS }] });
    expect(passo.reply).toMatch(/PROP-1/);
    expect(passo.reply).toMatch(/Valor da proposta/);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.proposalId).toBe("prop-1");
    expect(f.lidosPendentes).toEqual([]);
    expect(f.etapa).toBe("compor");
    expect(f.aguardaCampo).toBeDefined();
    expect(t.pausa.cancelar).toHaveBeenCalled();
  });

  it("SIM antes de a ficha ter sido mostrada: mostra a ficha, não grava (o corretor ainda não viu)", async () => {
    const t = montar({ texto: "sim" });
    const f = comPendentes(PEND, { etapa: "compor", fichaAgendadaEm: T0 + 20_000 });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect((passo.fluxo as FluxoFormularioV2).etapa).toBe("ficha");
  });

  it("SIM com a ficha agendada ainda pending (horário passou, mas o outbox não mandou): não grava, mostra a ficha e cancela a linha", async () => {
    const t = montar({ texto: "sim", agora: T0 + 25_000, entregue: false });
    const f = comPendentes(PEND, { etapa: "compor", fichaAgendadaEm: T0 + 20_000 });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(t.pausa.entregue).toHaveBeenCalledWith(`ficha:${SUBJECT}:${T0}`);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
    expect(t.pausa.cancelar).toHaveBeenCalled();
    expect((passo.fluxo as FluxoFormularioV2).fichaAgendadaEm).toBeUndefined();
  });

  it("SIM com a ficha agendada já ENTREGUE (linha sent): o corretor viu, então grava", async () => {
    const t = montar({ texto: "sim", agora: T0 + 25_000, entregue: true });
    const f = comPendentes(PEND, { etapa: "compor", fichaAgendadaEm: T0 + 20_000 });
    await conduzirV2(f, t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(1);
  });

  it("sem como saber se a ficha saiu (deps da pausa sem `entregue`): nunca vale como vista", async () => {
    const t = montar({ texto: "sim", agora: T0 + 25_000, semEntregue: true });
    const f = comPendentes(PEND, { etapa: "compor", fichaAgendadaEm: T0 + 20_000 });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toContain("📋");
  });

  it("SIM a uma pergunta do modelo depois de assunto fora: não grava (o assunto fora cancela a ficha e limpa o agendamento)", async () => {
    const f = comPendentes(PEND, { etapa: "compor", fichaAgendadaEm: T0 + 20_000 });
    const fora = montar({ texto: "qual a previsão do tempo amanhã?", args: {}, agora: T0 + 5_000 });
    const p1 = await conduzirV2(f, fora.ctx, fora.deps);
    expect(p1.liberar).toBe(true);
    expect(fora.pausa.cancelar).toHaveBeenCalled();
    expect((p1.fluxo as FluxoFormularioV2).fichaAgendadaEm).toBeUndefined();

    // O grafo rebaixa o fluxo devolvido num turno liberado; o SIM seguinte responde ao MODELO.
    const rebaixado = rebaixarFluxo(p1.fluxo) as FluxoFormularioV2;
    const sim = montar({ texto: "sim", agora: T0 + 30_000, entregue: true });
    const p2 = await conduzirV2(rebaixado, sim.ctx, sim.deps);
    expect(escritas(sim.acao)).toHaveLength(0);
    expect(p2.reply).toContain("📋");
  });

  it("assunto fora com a ficha já vista (etapa ficha): o SIM que responde ao modelo também não grava", async () => {
    const f = comPendentes(PEND, { etapa: "ficha" });
    const fora = montar({ texto: "qual a previsão do tempo amanhã?", args: {} });
    const p1 = await conduzirV2(f, fora.ctx, fora.deps);
    const sim = montar({ texto: "sim", agora: T0 + 30_000 });
    await conduzirV2(rebaixarFluxo(p1.fluxo) as FluxoFormularioV2, sim.ctx, sim.deps);
    expect(escritas(sim.acao)).toHaveLength(0);
  });

  it("rebaixarFluxo limpa a ficha agendada em qualquer etapa", () => {
    for (const etapa of ["entender", "compor", "ficha"] as const) {
      const r = rebaixarFluxo(fluxoBase({ etapa, fichaAgendadaEm: T0 + 20_000 })) as FluxoFormularioV2;
      expect(r.fichaAgendadaEm).toBeUndefined();
    }
  });

  it("NÃO: descarta o que estava pendente, nada é escrito", async () => {
    const t = montar({ texto: "não" });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha" }), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/descartei/i);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.lidosPendentes).toEqual([]);
    expect(lidosDoCofre(f, THREAD)).toEqual([]);
  });

  it("o que não cabe na proposta é dito, não fica pendente para sempre", async () => {
    const t = montar({ texto: "sim" });
    const f = comPendentes([L("compradores[0].nome", "Maria Souza Lima"), L("testemunhas[0].nome", "Ana Paula")], { etapa: "ficha" });
    const passo = await conduzirV2(f, t.ctx, t.deps);
    expect(passo.reply).toMatch(/não cabe na proposta/i);
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes).toEqual([]);
  });

  it("tudo preenchido: rascunho completo, fluxo encerrado (envio é de outra etapa)", async () => {
    const t = montar({
      texto: "sim",
      escrita: { status: 201, body: { proposal: { id: "prop-1", codigo: "PROP-1" }, faltando: [] } },
    });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha" }), t.ctx, t.deps);
    expect(passo.reply).toMatch(/completo/i);
    expect(passo.fluxo).toBeNull();
  });

  it("escrita sem resposta: texto honesto, chave e pendentes mantidos (o SIM seguinte não duplica)", async () => {
    const t = montar({ texto: "sim", escrita: null, messageId: "wamid.SIM1" });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha" }), t.ctx, t.deps);
    expect(passo.reply).toBe(TEXTO_ESCRITA_INCERTA);
    const f = passo.fluxo as FluxoFormularioV2;
    expect(f.chave).toEqual({ verbo: "proposal.create", valor: "wamid.SIM1" });
    expect(f.lidosPendentes.length).toBeGreaterThan(0);
  });

  it("403 fluxo_desligado na gravação: o fluxo volta para o v1, sem erro ao corretor", async () => {
    const t = montar({ texto: "sim", escrita: { status: 403, body: { error: "fluxo_desligado" } } });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha" }), t.ctx, t.deps);
    expect(passo.fluxo).toMatchObject({ kind: "proposta" });
    expect(passo.reply ?? "").not.toMatch(/erro|403/i);
  });

  it("proposta que saiu do rascunho (nao_editavel): diz e encerra, sem reter o dado", async () => {
    const t = montar({ texto: "sim", escrita: { status: 409, body: { error: "nao_editavel" } } });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(passo.reply).toMatch(/saiu do rascunho/i);
    expect(passo.fluxo).toBeNull();
  });

  it("campo `bloqueio` no 200 não existe no contrato (§18.13.5): é ignorado, nada do que ele traz chega ao corretor", async () => {
    const t = montar({
      texto: "sim",
      escrita: {
        status: 200,
        body: { proposta: { id: "prop-1", codigo: "PROP-1" }, faltando: [falta("negociacao.valor")], bloqueio: { codigo: "sem_modelo", mensagem: "Texto inventado pelo servidor." } },
      },
    });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(passo.reply).not.toContain("Texto inventado pelo servidor.");
    expect(passo.reply).not.toContain("sem_modelo");
    expect(passo.reply).toMatch(/Anotei e salvei/);
  });

  it("409 documento_proprio: explica com o link e SAI (sem oferecer um SIM que só repetiria o 409)", async () => {
    const link = "https://docs.google.com/document/d/abc/edit";
    const t = montar({ texto: "sim", escrita: { status: 409, body: { error: "documento_proprio", link } } });
    const passo = await conduzirV2(comPendentes(PEND, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(passo.reply).toContain(link);
    expect(passo.reply).not.toMatch(/\(SIM\)|refa[cç]a/i);
    expect(passo.fluxo).toBeNull();
    expect(escritas(t.acao)).toHaveLength(1);
  });
});

describe("N1: parte já gravada não é sobrescrita em silêncio", () => {
  const MARIA = [{ nome: "Maria Souza Lima", papel: "comprador" }];
  const OUTRO = [L("compradores[0].nome", "João Pereira Alves")];

  it("nome diferente na posição 1: pergunta (novo ou o mesmo), não escreve", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    const passo = await conduzirV2(comPendentes(OUTRO, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/Maria/);
    expect(passo.reply).toMatch(/novo/i);
    expect((passo.fluxo as FluxoFormularioV2).conflito).toEqual({ grupo: "compradores", posicao: 0 });
    expect(JSON.stringify(passo.fluxo)).not.toContain("Maria");
  });

  it("'é um novo': o João vai para o comprador 2 e a Maria fica intacta", async () => {
    const t = montar({ texto: "é um novo", optionsBody: options({ signatarios: MARIA, faltando: [] }), messageId: "wamid.NOVO" });
    const f = comPendentes(OUTRO, { etapa: "ficha", proposalId: "prop-1", conflito: { grupo: "compradores", posicao: 0 } });
    await conduzirV2(f, t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{}, { nome: "João Pereira Alves" }]);
  });

  it("'é o mesmo, troca': escreve com substituir:true", async () => {
    const t = montar({ texto: "é o mesmo, troca", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    const f = comPendentes(OUTRO, { etapa: "ficha", proposalId: "prop-1", conflito: { grupo: "compradores", posicao: 0 } });
    await conduzirV2(f, t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{ nome: "João Pereira Alves", substituir: true }]);
  });

  // I1: o documento também é identidade. CPF/CNPJ sem nome, numa posição já ocupada, não diz de QUEM é.
  const JOAO_CPF_SEM_NOME = [L("compradores[0].cpf", "11144477735")];

  it("I1: CPF sem nome na posição da Maria pergunta e deixa a Maria intacta (nada escrito)", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    const passo = await conduzirV2(comPendentes(JOAO_CPF_SEM_NOME, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/Maria/);
    expect(passo.reply).toMatch(/novo/i);
    expect((passo.fluxo as FluxoFormularioV2).conflito).toEqual({ grupo: "compradores", posicao: 0 });
    expect(JSON.stringify(passo.fluxo)).not.toContain("11144477735");
  });

  it("I1: o mesmo CPF como RESPOSTA ao campo perguntado (posição do `faltando` do servidor) grava, sem pergunta", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    const passo = await conduzirV2(comPendentes([LP("compradores[0].cpf", CPF_DIGITOS)], { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{ cpf: CPF_DIGITOS }]);
    expect((passo.fluxo as FluxoFormularioV2).conflito).toBeUndefined();
  });

  it("I1: CPF COM o nome da própria Maria (mesma pessoa) grava normalmente", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    await conduzirV2(comPendentes([L("compradores[0].nome", "Maria Souza Lima"), L("compradores[0].cpf", CPF_DIGITOS)], { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(1);
  });

  it("I1: CPF sem nome em posição LIVRE (ninguém lá) grava", async () => {
    const t = montar({ texto: "sim", optionsBody: options({ signatarios: [], faltando: [] }) });
    await conduzirV2(comPendentes(JOAO_CPF_SEM_NOME, { etapa: "ficha", proposalId: "prop-1" }), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(1);
  });

  it("I1/M9: 'é o mesmo, troca' num conflito só de documento não manda substituir:true sem nome (o servidor recusaria com 422)", async () => {
    const t = montar({ texto: "é o mesmo, troca", optionsBody: options({ signatarios: MARIA, faltando: [] }) });
    const f = comPendentes(JOAO_CPF_SEM_NOME, { etapa: "ficha", proposalId: "prop-1", conflito: { grupo: "compradores", posicao: 0 } });
    await conduzirV2(f, t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: Array<Record<string, unknown>> }];
    expect(corpo.compradores[0]).toEqual({ cpf: "11144477735" });
    expect(corpo.compradores[0]).not.toHaveProperty("substituir");
  });
});

describe("I2: a resposta ao conflito com NEGAÇÃO nunca vira 'é o mesmo'", () => {
  const MARIA = [{ nome: "Maria Souza Lima", papel: "comprador" }];
  const OUTRO = [L("compradores[0].nome", "João Pereira Alves")];
  const aberto = () => comPendentes(OUTRO, { etapa: "ficha", proposalId: "prop-1", conflito: { grupo: "compradores", posicao: 0 } });
  const opts = () => options({ signatarios: MARIA, faltando: [] });

  it.each(["não troca", "não trocar não", "não corrige", "não é ela", "não substitui a Maria"])("%s: não grava e pergunta de novo", async (texto) => {
    const t = montar({ texto, optionsBody: opts() });
    const passo = await conduzirV2(aberto(), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect(passo.reply).toMatch(/novo/i);
    expect((passo.fluxo as FluxoFormularioV2).conflito).toEqual({ grupo: "compradores", posicao: 0 });
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes.length).toBeGreaterThan(0);
  });

  it("'não' sozinho não descarta os pendentes: pergunta de novo e explica como descartar", async () => {
    const t = montar({ texto: "não", optionsBody: opts() });
    const passo = await conduzirV2(aberto(), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes.length).toBeGreaterThan(0);
    expect((passo.fluxo as FluxoFormularioV2).conflito).toBeDefined();
    expect(passo.reply).toMatch(/descart/i);
  });

  it("'descarta isso' descarta (ordem explícita)", async () => {
    const t = montar({ texto: "descarta isso", optionsBody: opts() });
    const passo = await conduzirV2(aberto(), t.ctx, t.deps);
    expect(passo.reply).toMatch(/descartei/i);
    expect((passo.fluxo as FluxoFormularioV2).lidosPendentes).toEqual([]);
    expect(escritas(t.acao)).toHaveLength(0);
  });

  it("'não corrige, é outra' vale como 'é um novo' (a oração negada não vota)", async () => {
    const t = montar({ texto: "não corrige, é outra", optionsBody: opts() });
    await conduzirV2(aberto(), t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{}, { nome: "João Pereira Alves" }]);
  });

  it("'não é outro, é o mesmo' vale como o mesmo (troca)", async () => {
    const t = montar({ texto: "não é outro, é o mesmo", optionsBody: opts() });
    await conduzirV2(aberto(), t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{ nome: "João Pereira Alves", substituir: true }]);
  });

  it("'não é o mesmo' continua sendo 'é um novo'", async () => {
    const t = montar({ texto: "não é o mesmo", optionsBody: opts() });
    await conduzirV2(aberto(), t.ctx, t.deps);
    const [, corpo] = escritas(t.acao)[0] as [string, { compradores: unknown[] }];
    expect(corpo.compradores).toEqual([{}, { nome: "João Pereira Alves" }]);
  });

  // Rodada 2: a negação vale em qualquer posição, com e sem pontuação; na dúvida nunca vira "o mesmo".
  it.each(["não corrige é outra", "nao, é outra", "outra pessoa", "não é a mesma", "é a mesma não", "não é o mesmo, não troca"])(
    "%s vale como 'é um novo' (nunca substitui)",
    async (texto) => {
      const t = montar({ texto, optionsBody: opts() });
      await conduzirV2(aberto(), t.ctx, t.deps);
      const [, corpo] = escritas(t.acao)[0] as [string, { compradores: Array<Record<string, unknown>> }];
      expect(corpo.compradores).toEqual([{}, { nome: "João Pereira Alves" }]);
      expect(JSON.stringify(corpo)).not.toContain("substituir");
    }
  );

  it.each(["não é ela", "é a mesma, não", "não, é o mesmo"])(
    "%s: na dúvida não grava e pergunta de novo",
    async (texto) => {
      const t = montar({ texto, optionsBody: opts() });
      const passo = await conduzirV2(aberto(), t.ctx, t.deps);
      expect(escritas(t.acao)).toHaveLength(0);
      expect(passo.reply).toMatch(/novo/i);
      expect((passo.fluxo as FluxoFormularioV2).conflito).toEqual({ grupo: "compradores", posicao: 0 });
    }
  );

  it("resposta contraditória ('novo' e 'o mesmo' juntos) pergunta de novo", async () => {
    const t = montar({ texto: "é um novo, é o mesmo", optionsBody: opts() });
    await conduzirV2(aberto(), t.ctx, t.deps);
    expect(escritas(t.acao)).toHaveLength(0);
  });
});

describe("I3: a janela de extração recomeça depois do SIM e do NÃO", () => {
  const PEND = [L("compradores[0].nome", "Maria Souza Lima"), L("compradores[0].cpf", CPF_DIGITOS)];

  it("depois do SIM a mensagem nova não traz de volta o que foi gravado (janela 0)", async () => {
    const f = comPendentes(PEND, { etapa: "ficha", mensagensDoFluxo: 3 });
    const t1 = montar({ texto: "sim" });
    const p1 = await conduzirV2(f, t1.ctx, t1.deps);
    const f1 = p1.fluxo as FluxoFormularioV2;
    expect(f1.mensagensDoFluxo).toBe(4);
    expect(f1.janelaDesde).toBe(4);

    // (sem a pergunta de campo que o SIM deixou aberta: ela responderia o turno sem extrair)
    const t2 = montar({ texto: "o valor é 500 mil", args: { negociacao: { valor: 500000 } } });
    await conduzirV2({ ...f1, aguardaCampo: undefined }, t2.ctx, t2.deps);
    expect(t2.janelaDoTurno).toHaveBeenCalledWith(0);
  });

  it("depois do NÃO o descartado não volta (janela 0)", async () => {
    const f = comPendentes(PEND, { etapa: "ficha", mensagensDoFluxo: 2 });
    const t1 = montar({ texto: "não" });
    const p1 = await conduzirV2(f, t1.ctx, t1.deps);
    const f1 = p1.fluxo as FluxoFormularioV2;
    expect(f1.janelaDesde).toBe(f1.mensagensDoFluxo);

    const t2 = montar({ texto: "o valor é 500 mil", args: { negociacao: { valor: 500000 } } });
    await conduzirV2(f1, t2.ctx, t2.deps);
    expect(t2.janelaDoTurno).toHaveBeenCalledWith(0);
  });

  it("sem SIM/NÃO a janela segue contando as mensagens do fluxo (sem janelaDesde = desde o começo)", async () => {
    const t = montar({ texto: "o valor é 500 mil", args: { negociacao: { valor: 500000 } } });
    await conduzirV2(fluxoBase({ mensagensDoFluxo: 2 }), t.ctx, t.deps);
    expect(t.janelaDoTurno).toHaveBeenCalledWith(2);
  });

  it("depois de gravar, mensagens seguintes entram na janela a partir do recomeço", async () => {
    const t = montar({ texto: "o valor é 500 mil", args: { negociacao: { valor: 500000 } } });
    await conduzirV2(fluxoBase({ mensagensDoFluxo: 5, janelaDesde: 4 }), t.ctx, t.deps);
    expect(t.janelaDoTurno).toHaveBeenCalledWith(1);
  });
});

describe("contagem de entradas do fluxo (P2)", () => {
  it("cada turno tratado conta 1 mensagem", async () => {
    const tratado = montar({ texto: "o que falta?" });
    const p1 = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), tratado.ctx, tratado.deps);
    expect((p1.fluxo as FluxoFormularioV2).mensagensDoFluxo).toBe(1);
  });

  // I4: a mensagem liberada para o atendimento entra no histórico do corretor. Se o fluxo continua,
  // ela conta; do contrário a janela da próxima extração desalinharia e puxaria o "bom dia" junto.
  it("I4: turno liberado com o fluxo mantido CONTA (assunto fora)", async () => {
    const livre = montar({ texto: "bom dia", args: {} });
    const p2 = await conduzirV2(fluxoBase({ proposalId: "prop-1" }), livre.ctx, livre.deps);
    expect(p2.liberar).toBe(true);
    expect((p2.fluxo as FluxoFormularioV2).mensagensDoFluxo).toBe(1);
  });

  it("I4: turno liberado que encerra o fluxo não tem o que contar", async () => {
    const livre = montar({ texto: "bom dia", args: {} });
    const p2 = await conduzirV2(fluxoBase(), livre.ctx, livre.deps);
    expect(p2.liberar).toBe(true);
    expect(p2.fluxo).toBeNull();
  });

  it("I4: 'sistema fora do ar' (options sem resposta) também conta o turno", async () => {
    const t = montar({ texto: "sim", optionsBody: null });
    const p = await conduzirV2(comPendentes([L("compradores[0].nome", "Maria Souza Lima")], { etapa: "ficha", mensagensDoFluxo: 2 }), t.ctx, t.deps);
    expect((p.fluxo as FluxoFormularioV2).mensagensDoFluxo).toBe(3);
  });
});
