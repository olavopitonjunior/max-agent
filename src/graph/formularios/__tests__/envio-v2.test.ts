import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as F from "../../fluxos";
import type { ContextoDoTurno, DepsDoFluxo, Fluxo, RespostaDoServidor } from "../../fluxos";
import { consumirFlowDoTurno } from "../../../lib/meta-flow";
import type { FluxoFormularioV2 } from "../estado";

/**
 * T14 (PR-D): o envio para assinatura no fluxo v2. NEGADOS PRIMEIRO: flag OFF = v1 byte a byte;
 * "ok"/"blz" nunca valem como SIM; nada escreve sem cartão + SIM. Depois os permitidos.
 * CPF só o sintético 52998224725 (e o envio nunca o mostra: o contrato nem o manda).
 */

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const ORG = "org-envio";
const T0 = 1_800_000_000_000;
const LINK = "https://app.exemplo.test/configuracoes/testemunhas";
const CPF_DIGITOS = "52998224725";

type Fila = Record<string, Array<RespostaDoServidor | null>>;

function optionsBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }, { valor: "email", rotulo: "E-mail" }],
    signatarios: [{ nome: "Letícia Gonçalves", papel: "proponente", posicao: 1 }],
    assinaturaConfigurada: true,
    modalidades: [],
    obrigatorios: [
      { chave: "proponente.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" },
    ],
    faltando: [],
    fluxoV2: true,
    testemunhas: {
      minimo: 1,
      maximo: 4,
      padrao: [
        { idPadrao: "t-1", nome: "Ana Testemunha", obrigatoria: true, podeAceite: true },
        { idPadrao: "t-2", nome: "Beto Testemunha", obrigatoria: false, podeAceite: true },
        { idPadrao: "t-3", nome: "Caio Testemunha", obrigatoria: false, podeAceite: false },
      ],
      linkConfiguracoes: LINK,
    },
    tiposDeAssinatura: [
      { tipo: "email", disponivel: true, texto: "E-mail" },
      { tipo: "whatsapp", disponivel: true, texto: "WhatsApp" },
      { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" },
    ],
    ...extra,
  };
}

const PRONTO_ENVELOPE = {
  instrumento: "envelope",
  tipoEfetivo: "email",
  assinantes: [{ nome: "Letícia Gonçalves", papel: "proponente", canal: "e-mail" }],
  consomeEnvioDoPlano: true,
  avisos: [],
  faltando: [],
};
const PRONTO_ACEITE = {
  instrumento: "aceite",
  tipoEfetivo: "aceite",
  assinantes: [{ nome: "Letícia Gonçalves", papel: "proponente", canal: "celular" }],
  consomeEnvioDoPlano: false,
  custoCentavos: 99,
  semLembrete: true,
  avisos: [],
  faltando: [],
};

const RASCUNHO = { id: "prop-1", codigo: "PROP-1", titulo: "Proposta — Letícia", estado: "Rascunho" };
const falta = (campo: string, papel = "proponente") => ({ signatario: { posicao: 1, papel }, campo, motivo: "obrigatorio_da_org" });

interface Montagem {
  options?: Record<string, unknown>;
  /** O `options` que o servidor devolve depois de uma gravação (ex.: o celular que faltava foi gravado). */
  optionsDepoisDeGravar?: Record<string, unknown>;
  fila?: Fila;
  semJanela?: boolean;
  orgId?: string | null;
  rascunhos?: Array<typeof RASCUNHO>;
  policy?: string[];
  podeEscrever?: boolean;
}

interface Chamada {
  verb: string;
  args: Record<string, unknown>;
  chave?: string;
}

function montar(m: Montagem = {}) {
  const fila: Fila = {};
  for (const [k, v] of Object.entries(m.fila ?? {})) fila[k] = [...v];
  const chamadas: Chamada[] = [];
  let atual = "";
  let gravou = false;
  const acao = vi.fn(async (verb: string, args: Record<string, unknown>, chave?: string): Promise<RespostaDoServidor | null> => {
    chamadas.push({ verb, args, chave });
    const q = fila[verb];
    if (q && q.length > 0) return q.shift()!;
    switch (verb) {
      case "proposal.list":
        return { status: 200, body: { items: m.rascunhos ?? [RASCUNHO] } };
      case "proposal.options":
        return { status: 200, body: (gravou && m.optionsDepoisDeGravar) || m.options || optionsBody() };
      case "proposal.preflight":
        return { status: 200, body: PRONTO_ENVELOPE };
      case "proposal.witnesses.set":
      case "proposal.update":
        if (verb === "proposal.update") gravou = true;
        return { status: 200, body: { proposta: { id: "prop-1" }, faltando: [] } };
      case "proposal.send":
        return { status: 200, body: { avisos: [] } };
      default:
        return null;
    }
  });
  const deps = {
    acao,
    extrairProposta: vi.fn(async () => null),
    extrairCampos: vi.fn(async () => null),
    ...(m.semJanela ? {} : { janelaDoTurno: vi.fn(() => ({ atual, anteriores: [] as string[], lidos: [] as never[] })), extrairComJanela: vi.fn(async () => ({})) }),
  } as unknown as DepsDoFluxo;

  let n = 0;
  let desvio = 0;
  const t = {
    /** Faz o relógio do turno andar (o resumo mostrado envelhece). */
    passa(ms: number) {
      desvio += ms;
    },
    acao,
    deps,
    chamadas,
    fluxo: null as Fluxo | null,
    ultima: null as { reply?: string; fluxo?: Fluxo | null; evento?: string } | null,
    ctx(texto: string, messageId?: string, botao?: string): ContextoDoTurno {
      atual = texto;
      n += 1;
      return {
        texto,
        messageId: messageId ?? `wamid.${n}`,
        policy: (m.policy ?? ["proposal.create", "proposal.send"]) as ContextoDoTurno["policy"],
        agora: T0 + n * 1000 + desvio,
        thread: "thread-envio",
        subjectKey: JSON.stringify([ORG, "u1"]),
        podeEscrever: m.podeEscrever ?? true,
        ...(m.orgId === null ? {} : { orgId: m.orgId ?? ORG }),
        ...(botao ? { botao } : {}),
      };
    },
    /** Um turno: o pedido de envio abre (retomarEnvio); os seguintes entram no fluxo aberto. */
    async fala(texto: string, messageId?: string, botao?: string) {
      const c = t.ctx(texto, messageId, botao);
      const passo = t.fluxo ? await F.conduzirFluxo(t.fluxo, c, deps) : await F.retomarEnvio(c, deps);
      const p = passo as { reply?: string; fluxo?: Fluxo | null; evento?: string };
      t.ultima = p;
      if ("fluxo" in p) t.fluxo = p.fluxo ?? null;
      return p;
    },
    verbos: () => chamadas.map((c) => c.verb),
    escritas: () => chamadas.filter((c) => ["proposal.witnesses.set", "proposal.update", "proposal.send"].includes(c.verb)),
    de: (verb: string) => chamadas.filter((c) => c.verb === verb),
    assinatura: () => (t.fluxo as FluxoFormularioV2 | null)?.assinatura,
  };
  return t;
}

type Mont = ReturnType<typeof montar>;

/** Abre o envio e chega ao cartão de testemunhas (2 turnos: lista, "sim" = ainda só o cartão). */
async function ateCartaoDeTestemunhas(t: Mont) {
  await t.fala("Envie a proposta");
  await t.fala("sim");
}

/** Do cartão de testemunhas até o resumo (grava as testemunhas, escolhe o tipo). */
async function ateResumo(t: Mont, tipo = "email") {
  await ateCartaoDeTestemunhas(t);
  await t.fala("sim", "wamid.sim-testemunhas");
  await t.fala(tipo);
}

beforeEach(() => {
  vi.stubEnv("MAX_FORMULARIOS_V2", "true");
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
  vi.stubEnv("MAX_INTERACTIVE", "");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_ASSINATURA", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const VERBOS_PERMITIDOS = new Set(["proposal.list", "proposal.options", "proposal.witnesses.set", "proposal.preflight", "proposal.update", "proposal.send"]);

// ─── Negados: com a flag desligada o v1 segue byte a byte ───────────────────

describe("negados: formularios_v2 OFF mantém o v1 byte a byte", () => {
  it("retomarEnvio: a resposta inteira é a do v1 e nada do v2 é chamado", async () => {
    vi.stubEnv("MAX_ROLLOUT_ORGS", "{}");
    const off = montar();
    const v1 = await off.fala("Envie a proposta");
    const base = montar({ orgId: null }); // sem org: o v1 de sempre
    const ref = await base.fala("Envie a proposta");
    expect(v1.reply).toBe(ref.reply);
    expect(v1.fluxo).toEqual(ref.fluxo);
    expect(v1.evento).toBe(ref.evento);
    expect(off.verbos()).toEqual(base.verbos());
    expect(off.verbos()).not.toContain("proposal.preflight");
    expect(off.verbos()).not.toContain("proposal.witnesses.set");
    expect((v1.fluxo as Fluxo).kind).toBe("proposta");
    expect(v1.reply).toBe(
      "Retomando a proposta PROP-1 — Proposta — Letícia.\n" +
        "Como os assinantes vão se identificar para assinar?\n1. WhatsApp\n2. E-mail\n\nResponda com o número."
    );
  });

  it("selecao_envio com duas propostas: escolher uma segue o v1, sem tocar no v2", async () => {
    vi.stubEnv("MAX_ROLLOUT_ORGS", "{}");
    const dois = [RASCUNHO, { ...RASCUNHO, id: "prop-2", codigo: "PROP-2" }];
    const off = montar({ rascunhos: dois });
    await off.fala("Envie a proposta");
    const v1 = await off.fala("1");
    const base = montar({ rascunhos: dois, orgId: null });
    await base.fala("Envie a proposta");
    const ref = await base.fala("1");
    expect(v1.reply).toBe(ref.reply);
    expect(v1.fluxo).toEqual(ref.fluxo);
    expect(off.verbos()).toEqual(base.verbos());
    expect(off.verbos()).not.toContain("proposal.preflight");
  });

  it("flag ligada mas o servidor diz fluxoV2:false para a proposta: v1 intacto", async () => {
    const on = montar({ options: optionsBody({ fluxoV2: false }) });
    const v1 = await on.fala("Envie a proposta");
    const base = montar({ options: optionsBody({ fluxoV2: false }), orgId: null });
    const ref = await base.fala("Envie a proposta");
    expect(v1.reply).toBe(ref.reply);
    expect((v1.fluxo as Fluxo).kind).toBe("proposta");
    expect(on.escritas()).toHaveLength(0);
    expect(on.verbos()).not.toContain("proposal.preflight");
  });

  it("flag ligada mas sem as deps da janela de extração: v1 intacto e sem consultar o options do v2", async () => {
    const on = montar({ semJanela: true });
    const v1 = await on.fala("Envie a proposta");
    expect((v1.fluxo as Fluxo).kind).toBe("proposta");
    expect(on.verbos()).not.toContain("proposal.preflight");
    expect(on.verbos()).not.toContain("proposal.witnesses.set");
  });

  it("sem orgId no turno (contexto antigo): nunca abre o v2", async () => {
    const t = montar({ orgId: null });
    const p = await t.fala("Envie a proposta");
    expect((p.fluxo as Fluxo).kind).toBe("proposta");
  });
});

// ─── Negados: nada escreve sem cartão + SIM ─────────────────────────────────

describe("negados: nenhuma escrita sem cartão e SIM (\"ok\" e \"blz\" nunca valem)", () => {
  it("abrir o envio não escreve nada: só lê (list, options)", async () => {
    const t = montar();
    const p = await t.fala("Envie a proposta");
    expect(t.escritas()).toHaveLength(0);
    expect((p.fluxo as FluxoFormularioV2).kind).toBe("proposta_v2");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    expect(p.reply).toContain("Testemunhas desta proposta");
  });

  it("o primeiro SIM da lista de testemunhas só mostra o cartão: ainda não grava", async () => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas_cartao" });
    expect(t.de("proposal.witnesses.set")).toHaveLength(0);
  });

  it.each(["ok", "blz", "beleza", "valeu"])("cartão de testemunhas: %s não grava", async (vago) => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    await t.fala(vago);
    expect(t.de("proposal.witnesses.set")).toHaveLength(0);
    expect(t.escritas()).toHaveLength(0);
  });

  it.each(["ok", "blz", "beleza", "valeu"])("resumo do envio: %s não envia", async (vago) => {
    const t = montar();
    await ateResumo(t);
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
    const p = await t.fala(vago);
    expect(t.de("proposal.send")).toHaveLength(0);
    expect(p.reply).toContain("responda *SIM*");
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
  });

  it.each(["ok", "blz"])("cartão de troca de canal: %s não grava o canal", async (vago) => {
    // canal gravado = e-mail; o corretor pede WhatsApp: precisa de cartão + SIM
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("whatsapp");
    expect(t.assinatura()).toMatchObject({ passo: "canal_cartao" });
    await t.fala(vago);
    expect(t.de("proposal.update")).toHaveLength(0);
  });

  it.each(["ok", "blz"])("aviso de regerar o documento: %s não regera", async (vago) => {
    const t = montar({ fila: { "proposal.update": [{ status: 409, body: { error: "documento_proprio" } }] } });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("whatsapp");
    await t.fala("sim", "wamid.sim-canal"); // tenta gravar o canal: 409 documento_proprio
    expect(t.assinatura()).toMatchObject({ passo: "regerar" });
    await t.fala(vago);
    const updates = t.de("proposal.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args).not.toHaveProperty("regerar_documento");
  });

  it("a mesma fala do pedido de envio no resumo reabre o fluxo, nunca envia", async () => {
    const t = montar();
    await ateResumo(t);
    await t.fala("Envie a proposta");
    expect(t.de("proposal.send")).toHaveLength(0);
  });

  it("uma interrupção desfaz o cartão: o SIM seguinte não grava nem envia", async () => {
    const t = montar();
    await ateResumo(t);
    t.fluxo = F.rebaixarFluxo(t.fluxo);
    expect(t.assinatura()).toMatchObject({ passo: "tipo" });
    await t.fala("sim");
    expect(t.de("proposal.send")).toHaveLength(0);
    expect(t.de("proposal.update")).toHaveLength(0);
  });

  it("uma interrupção no cartão de testemunhas volta para a lista: o SIM não grava", async () => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    t.fluxo = F.rebaixarFluxo(t.fluxo);
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    await t.fala("ok");
    expect(t.de("proposal.witnesses.set")).toHaveLength(0);
  });

  it("sem permissão de escrita no turno (podeEscrever false): o SIM do resumo não envia", async () => {
    const t = montar();
    await ateResumo(t);
    t.ctx("x"); // avança o relógio; o contexto abaixo é refeito sem escrita
    const c: ContextoDoTurno = { ...t.ctx("sim"), podeEscrever: false };
    const p = (await F.conduzirFluxo(t.fluxo!, c, t.deps)) as { reply: string };
    expect(t.de("proposal.send")).toHaveLength(0);
    expect(p.reply).toContain("não");
  });

  it("nunca fala com o cliente final: o único alvo de toda chamada é o servidor do corretor", async () => {
    const t = montar();
    await ateResumo(t);
    await t.fala("sim", "wamid.sim-envio");
    for (const v of t.verbos()) expect(VERBOS_PERMITIDOS.has(v)).toBe(true);
  });
});

// ─── Negados: 403 fluxo_desligado (D3) ──────────────────────────────────────

describe("negados: 403 fluxo_desligado vira v1, sem mensagem de erro (D3)", () => {
  it("no proposal.witnesses.set", async () => {
    const t = montar({ fila: { "proposal.witnesses.set": [{ status: 403, body: { error: "fluxo_desligado" } }] } });
    await ateCartaoDeTestemunhas(t);
    const p = await t.fala("sim", "wamid.sim-testemunhas");
    expect((p.fluxo as Fluxo).kind).toBe("proposta");
    expect(p.reply).not.toMatch(/fluxo_desligado|erro|não consegui/i);
    expect(p.reply).toContain("Como os assinantes vão se identificar para assinar?");
  });

  it("no proposal.send (o resumo já tinha sido mostrado)", async () => {
    const t = montar({ fila: { "proposal.send": [{ status: 403, body: { error: "fluxo_desligado" } }] } });
    await ateResumo(t);
    const p = await t.fala("sim", "wamid.sim-envio");
    expect((p.fluxo as Fluxo).kind).toBe("proposta");
    expect(p.reply).not.toMatch(/fluxo_desligado|erro|não consegui/i);
    expect(p.reply).toContain("Como os assinantes vão se identificar para assinar?");
  });

  it("no proposal.preflight", async () => {
    const t = montar({ fila: { "proposal.preflight": [{ status: 403, body: { error: "fluxo_desligado" } }] } });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    const p = await t.fala("email");
    expect((p.fluxo as Fluxo).kind).toBe("proposta");
    expect(t.de("proposal.send")).toHaveLength(0);
  });

  it("403 de política (não é fluxo_desligado) NÃO rebaixa: diz que falta permissão", async () => {
    const t = montar({ fila: { "proposal.send": [{ status: 403, body: { error: "politica_nao_concede" } }] } });
    await ateResumo(t);
    const p = await t.fala("sim", "wamid.sim-envio");
    expect((p.fluxo as Fluxo | null)?.kind).not.toBe("proposta");
    expect(p.reply).toMatch(/permiss|liberad/i);
  });
});

// ─── T14 (permitidos) ───────────────────────────────────────────────────────

describe("T14: resumo, envio e idempotência", () => {
  it("resumo mostra instrumento, tipoEfetivo, assinantes, custo só se consomeEnvioDoPlano", async () => {
    // Envelope: consome o plano, nunca mostra R$.
    const env = montar();
    await ateResumo(env);
    const r1 = env.ultima!.reply!;
    expect(r1).toContain("Instrumento: envelope de assinatura digital");
    expect(r1).toContain("Tipo: e-mail");
    expect(r1).toContain("Letícia Gonçalves (proponente), por e-mail");
    expect(r1).toContain("Consome 1 envio do plano da conta.");
    expect(r1).not.toContain("R$");

    // Aceite: não consome o plano, tem custo e vem sem lembrete.
    const ace = montar({ fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ACEITE }] } });
    await ateResumo(ace, "aceite");
    const r2 = ace.ultima!.reply!;
    expect(r2).toContain("Instrumento: Aceite no celular");
    expect(r2).toContain("Tipo: Aceite no celular");
    expect(r2).toContain("Custo: R$ 0,99, sem lembrete.");
    expect(r2).not.toContain("Consome 1 envio do plano");

    // Envelope que NÃO consome o plano (ilimitado): sem a linha de consumo e sem R$.
    const livre = montar({ fila: { "proposal.preflight": [{ status: 200, body: { ...PRONTO_ENVELOPE, consomeEnvioDoPlano: false } }] } });
    await ateResumo(livre);
    expect(livre.ultima!.reply).not.toContain("Consome");
    expect(livre.ultima!.reply).not.toContain("R$");
    expect(livre.ultima!.reply).toContain("Responda *SIM* para enviar.");
  });

  it("send leva instrumento_confirmado do preflight mostrado", async () => {
    const t = montar();
    await ateResumo(t);
    const p = await t.fala("sim", "wamid.sim-envio");
    const envios = t.de("proposal.send");
    expect(envios).toHaveLength(1);
    expect(envios[0]!.args).toEqual({ proposta_id: "prop-1", instrumento_confirmado: "envelope", tipo_assinatura: "email" });
    expect(p.reply).toContain("Proposta enviada para assinatura (envelope de assinatura).");
    expect(p.fluxo).toBeNull();
  });

  // I3 (R22): o resumo mostrado vale 15 minutos. Depois disso o SIM refaz o preflight e pede um SIM novo.
  describe("I3: o resumo do envio tem validade (R22, 15 min)", () => {
    const QUINZE_MIN = 15 * 60 * 1000;

    it("SIM depois de 15 min NUNCA envia: refaz o preflight, mostra o resumo de novo e pede novo SIM", async () => {
      const t = montar();
      await ateResumo(t);
      expect(t.de("proposal.preflight")).toHaveLength(1);
      t.passa(QUINZE_MIN + 1000);
      const p = await t.fala("sim", "wamid.sim-velho");
      expect(t.de("proposal.send")).toHaveLength(0);
      expect(t.de("proposal.preflight")).toHaveLength(2);
      expect(p.reply).toMatch(/mais de 15 minutos/);
      expect(p.reply).toContain("Antes de enviar, confira:");
      expect(p.reply).toContain("Responda *SIM* para enviar.");
      expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
      expect((t.fluxo as FluxoFormularioV2).chave).toBeUndefined();
      // O SIM novo (chave nova) é que envia, com o instrumento do resumo refeito.
      await t.fala("sim", "wamid.sim-novo");
      const envios = t.de("proposal.send");
      expect(envios).toHaveLength(1);
      expect(envios[0]!.chave).toBe("wamid.sim-novo");
    });

    it("SIM dentro dos 15 min envia normalmente (sem refazer o preflight)", async () => {
      const t = montar();
      await ateResumo(t);
      t.passa(QUINZE_MIN - 5000);
      await t.fala("sim", "wamid.sim-fresco");
      expect(t.de("proposal.preflight")).toHaveLength(1);
      expect(t.de("proposal.send")).toHaveLength(1);
    });

    it("o resumo refeito que agora tem pendência volta para a ficha e não envia", async () => {
      const t = montar({ fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ENVELOPE }, { status: 200, body: { ...PRONTO_ENVELOPE, faltando: [falta("proponente.documento")] } }] } });
      await ateResumo(t);
      t.passa(QUINZE_MIN + 1000);
      await t.fala("sim", "wamid.sim-velho");
      expect(t.de("proposal.send")).toHaveLength(0);
      expect(t.assinatura()).toBeUndefined();
    });

    it("SIM sem resposta e retry DENTRO de 15 min: repete o send com a mesma chave, sem refazer o preflight", async () => {
      const t = montar({ fila: { "proposal.send": [null] } });
      await ateResumo(t);
      await t.fala("sim", "wamid.sim-1");
      expect(t.de("proposal.send")).toHaveLength(1);
      t.passa(QUINZE_MIN - 60_000);
      await t.fala("sim", "wamid.sim-2");
      const envios = t.de("proposal.send");
      expect(envios).toHaveLength(2);
      expect(envios[1]!.chave).toBe("wamid.sim-1");
      expect(t.de("proposal.preflight")).toHaveLength(1);
    });

    it("SIM sem resposta e retry DEPOIS de 15 min: refaz o preflight, pede SIM novo e só então reenvia, com a chave pendente", async () => {
      const t = montar({ fila: { "proposal.send": [null] } });
      await ateResumo(t);
      await t.fala("sim", "wamid.sim-1");
      expect(t.de("proposal.send")).toHaveLength(1);
      t.passa(QUINZE_MIN + 60_000);
      const p = await t.fala("sim", "wamid.sim-2");
      // Este SIM não envia: o resumo é refeito e o corretor confirma de novo.
      expect(t.de("proposal.send")).toHaveLength(1);
      expect(t.de("proposal.preflight")).toHaveLength(2);
      expect(p.reply).toMatch(/mais de 15 minutos/);
      expect(p.reply).toContain("Responda *SIM* para enviar.");
      expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
      // A chave do primeiro SIM fica pendente: o servidor deduplica se aquele envio chegou.
      expect((t.fluxo as FluxoFormularioV2).chave).toEqual({ verbo: "proposal.send", valor: "wamid.sim-1" });
      await t.fala("sim", "wamid.sim-3");
      const envios = t.de("proposal.send");
      expect(envios).toHaveLength(2);
      expect(envios[1]!.chave).toBe("wamid.sim-1");
      expect(t.de("proposal.preflight")).toHaveLength(2);
    });
  });

  // M2: o send leva os MESMOS parâmetros do preflight (§18.13.7), mesmo depois de gravar o canal.
  it("M2: o send usa o tipo_assinatura do preflight (e não o tipoEfetivo) depois de gravar o canal", async () => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("whatsapp");
    await t.fala("sim", "wamid.sim-canal"); // grava o canal; o preflight seguinte ainda diz e-mail (aviso, não novo cartão)
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao", mostrado: { tipoEfetivo: "email" } });
    await t.fala("sim", "wamid.sim-envio");
    const preflights = t.de("proposal.preflight");
    const ultimo = preflights[preflights.length - 1]!.args.tipo_assinatura;
    expect(ultimo).toBe("whatsapp");
    expect(t.de("proposal.send")[0]!.args).toEqual({ proposta_id: "prop-1", instrumento_confirmado: "envelope", tipo_assinatura: ultimo });
  });

  // M1: nada de código cru do servidor no resumo.
  it("M1: o resumo fala em português (papel, canal e instrumento), sem códigos crus", async () => {
    const t = montar({
      fila: {
        "proposal.preflight": [
          {
            status: 200,
            body: {
              ...PRONTO_ENVELOPE,
              assinantes: [
                { nome: "Letícia Gonçalves", papel: "proponente", canal: "whatsapp", via: "assinatura" },
                { nome: "Valter Vendedor", papel: "vendedor", canal: "email", via: "assinatura" },
                { nome: "Cora Cônjuge", papel: "conjuge", canal: "email", via: "assinatura" },
                { nome: "Dora Testemunha", papel: "testemunha", canal: "email", via: "assinatura" },
              ],
            },
          },
        ],
      },
    });
    await ateResumo(t);
    const r = t.ultima!.reply!;
    expect(r).toContain("Letícia Gonçalves (proponente), por WhatsApp");
    expect(r).toContain("Valter Vendedor (vendedor), por e-mail");
    expect(r).toContain("Cora Cônjuge (cônjuge)");
    expect(r).toContain("Dora Testemunha (testemunha)");
    expect(r).not.toMatch(/\bvia\b/);
    expect(r).not.toMatch(/conjuge|whatsapp|assinatura\b.*assinatura/);
    expect(r).not.toContain("email");
  });

  it("M1: o Aceite mostra 'Aceite no celular' por assinante, sem 'via aceite'", async () => {
    const t = montar({
      fila: { "proposal.preflight": [{ status: 200, body: { ...PRONTO_ACEITE, assinantes: [{ nome: "Letícia Gonçalves", papel: "proponente", canal: "whatsapp", via: "aceite" }] } }] },
    });
    await ateResumo(t, "aceite");
    const r = t.ultima!.reply!;
    expect(r).toContain("Letícia Gonçalves (proponente), pelo celular (Aceite)");
    expect(r).not.toMatch(/\bvia\b|whatsapp/);
  });

  it("whatsapp pedido que sai como Aceite é a divergência aceita: confirma o instrumento mostrado", async () => {
    const t = montar({ fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ACEITE }] } });
    await ateResumo(t, "whatsapp");
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao", mostrado: { instrumento: "aceite", tipoEfetivo: "aceite" } });
    await t.fala("sim", "wamid.sim-envio");
    expect(t.de("proposal.send")[0]!.args).toEqual({ proposta_id: "prop-1", instrumento_confirmado: "aceite", tipo_assinatura: "whatsapp" });
  });

  it("409 instrumento_mudou refaz o preflight e pede novo 'sim' (chave nova, nada enviado)", async () => {
    const t = montar({
      fila: {
        "proposal.send": [{ status: 409, body: { error: "instrumento_mudou" } }],
        "proposal.preflight": [{ status: 200, body: { ...PRONTO_ENVELOPE, tipoEfetivo: "whatsapp" } }, { status: 200, body: PRONTO_ACEITE }],
      },
    });
    await ateResumo(t, "whatsapp");
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao", mostrado: { instrumento: "envelope" } });
    const p = await t.fala("sim", "wamid.sim-1");
    expect(t.de("proposal.send")).toHaveLength(1);
    expect(t.de("proposal.preflight")).toHaveLength(2);
    expect(p.reply).toContain("não enviei nada");
    expect(p.reply).toContain("Instrumento: Aceite no celular");
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao", mostrado: { instrumento: "aceite" } });
    expect((t.fluxo as FluxoFormularioV2).chave).toBeUndefined();
    // Sem novo SIM não sai nada; com o novo SIM sai com o instrumento NOVO e a chave NOVA.
    await t.fala("ok");
    expect(t.de("proposal.send")).toHaveLength(1);
    await t.fala("sim", "wamid.sim-2");
    const envios = t.de("proposal.send");
    expect(envios).toHaveLength(2);
    expect(envios[0]!.chave).toBe("wamid.sim-1");
    expect(envios[1]!.chave).toBe("wamid.sim-2");
    expect(envios[1]!.args.instrumento_confirmado).toBe("aceite");
  });

  it("422 pendencias volta para a ficha e pergunta o dado", async () => {
    const t = montar({
      fila: { "proposal.send": [{ status: 422, body: { error: "pendencias", faltando: [falta("proposta.documento")] } }] },
      options: optionsBody({
        obrigatorios: [{ chave: "proposta.documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "venda", tipoCampo: "cpf_cnpj" }],
      }),
    });
    await ateResumo(t);
    const p = await t.fala("sim", "wamid.sim-envio");
    expect(p.reply).toContain("Para enviar ainda falta um dado.");
    expect(t.assinatura()).toBeUndefined();
    expect((t.fluxo as FluxoFormularioV2).kind).toBe("proposta_v2");
    expect(t.de("proposal.send")).toHaveLength(1);
  });

  it("idempotencyKey = messageId do primeiro sim; reenvio do sim não duplica", async () => {
    const t = montar({ fila: { "proposal.send": [null, { status: 200, body: { avisos: [] } }] } });
    await ateResumo(t);
    const p1 = await t.fala("sim", "wamid.sim-A");
    expect(p1.reply).toBe(F.TEXTO_ESCRITA_INCERTA);
    expect((t.fluxo as FluxoFormularioV2).chave).toEqual({ verbo: "proposal.send", valor: "wamid.sim-A" });
    // Qualquer coisa que não seja o SIM pede para resolver antes (e não manda nada).
    const meio = await t.fala("e agora?");
    expect(meio.evento).toBe("escrita_em_aberto");
    expect(t.de("proposal.send")).toHaveLength(1);
    // O SIM de novo REPETE a chave original: o servidor deduplica.
    const p2 = await t.fala("sim", "wamid.sim-B");
    const envios = t.de("proposal.send");
    expect(envios).toHaveLength(2);
    expect(envios.map((e) => e.chave)).toEqual(["wamid.sim-A", "wamid.sim-A"]);
    expect(p2.reply).toContain("Proposta enviada");
    expect(p2.fluxo).toBeNull();
  });

  it("409 ja_enviando também guarda a chave (não gera outra)", async () => {
    const t = montar({ fila: { "proposal.send": [{ status: 409, body: { error: "ja_enviando" } }] } });
    await ateResumo(t);
    await t.fala("sim", "wamid.sim-A");
    expect((t.fluxo as FluxoFormularioV2).chave).toEqual({ verbo: "proposal.send", valor: "wamid.sim-A" });
  });

  it("canal escolhido aqui, nunca antes: nada leva tipo_assinatura até a escolha, e a gravação do canal exige SIM", async () => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    // Até a lista de tipos: nenhuma chamada carrega tipo_assinatura.
    expect(t.assinatura()).toMatchObject({ passo: "tipo" });
    for (const c of t.chamadas) expect(c.args).not.toHaveProperty("tipo_assinatura");
    expect(t.de("proposal.update")).toHaveLength(0);
    expect(t.de("proposal.preflight")).toHaveLength(0);

    // Escolhe WhatsApp, mas o servidor diz que hoje sai como e-mail: cartão do canal, sem gravar.
    await t.fala("whatsapp");
    expect(t.de("proposal.preflight")[0]!.args).toEqual({ proposta_id: "prop-1", tipo_assinatura: "whatsapp" });
    expect(t.assinatura()).toMatchObject({ passo: "canal_cartao" });
    expect(t.de("proposal.update")).toHaveLength(0);

    // O SIM grava o canal com a chave DESTE sim, refaz o preflight e mostra o resumo.
    await t.fala("sim", "wamid.sim-canal");
    const updates = t.de("proposal.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args).toEqual({ proposta_id: "prop-1", tipo_assinatura: "whatsapp" });
    expect(updates[0]!.chave).toBe("wamid.sim-canal");
    expect(t.de("proposal.preflight")).toHaveLength(2);
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
    expect(t.de("proposal.send")).toHaveLength(0);
  });

  it("plano esgotado (402) responde com a frase do plano, sem inventar valor", async () => {
    const t = montar({ fila: { "proposal.send": [{ status: 402, body: { error: "plan_limit" } }] } });
    await ateResumo(t);
    const p = await t.fala("sim", "wamid.sim-envio");
    expect(p.reply).toBe("O plano de assinaturas da imobiliária esgotou. Fale com o administrador.");
    expect(p.reply).not.toContain("R$");
  });

  it("o estado do fluxo não leva dado pessoal (só ids opacos e escolhas)", async () => {
    const t = montar();
    await ateResumo(t);
    const bruto = JSON.stringify(t.fluxo);
    expect(bruto).not.toContain(CPF_DIGITOS);
    expect(bruto).not.toContain("Ana Testemunha");
    expect(bruto).not.toContain("Letícia");
  });
});

// ─── T13 no condutor: testemunhas, tipo, celular, regerar ───────────────────

describe("T13 ligado ao condutor", () => {
  it("teto 4: o 422 teto_testemunhas volta para a lista com a frase do teto", async () => {
    const t = montar({ fila: { "proposal.witnesses.set": [{ status: 422, body: { error: "teto_testemunhas", maximo: 4 } }] } });
    await ateCartaoDeTestemunhas(t);
    const p = await t.fala("sim", "wamid.sim-testemunhas");
    expect(p.reply).toContain("4");
    expect(p.reply).toContain("Testemunhas desta proposta");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
  });

  // I1: com 4 no cadastro (e a testemunha-corretor que o Max não vê), marcar tudo dava 422 em laço.
  const quatroNoCadastro = () =>
    optionsBody({
      testemunhas: {
        minimo: 2,
        maximo: 4,
        padrao: [
          { idPadrao: "c-1", nome: "Ana Testemunha", obrigatoria: true, podeAceite: true },
          { idPadrao: "c-2", nome: "Beto Testemunha", obrigatoria: false, podeAceite: true },
          { idPadrao: "c-3", nome: "Caio Testemunha", obrigatoria: false, podeAceite: true },
          { idPadrao: "c-4", nome: "Dora Testemunha", obrigatoria: false, podeAceite: true },
        ],
        linkConfiguracoes: LINK,
      },
    });

  it("I1: cadastro de 4 — a lista marca o par semeado e o SIM grava só o par (não as 4)", async () => {
    const t = montar({ options: quatroNoCadastro() });
    const lista = await t.fala("Envie a proposta");
    expect(lista.reply).toContain("1. ✅ Ana Testemunha (obrigatória)");
    expect(lista.reply).toContain("2. ✅ Beto Testemunha");
    expect(lista.reply).toContain("3. ⬜ Caio Testemunha");
    expect(lista.reply).toContain("4. ⬜ Dora Testemunha");
    await t.fala("manter");
    await t.fala("sim", "wamid.sim-testemunhas");
    const w = t.de("proposal.witnesses.set");
    expect(w).toHaveLength(1);
    expect(w[0]!.args).toEqual({ proposta_id: "prop-1", testemunhas: [{ idPadrao: "c-1" }, { idPadrao: "c-2" }] });
  });

  it("I1: o 422 teto_testemunhas não repete o mesmo envio em laço — volta explicando o teto, só com as obrigatórias", async () => {
    const t = montar({
      options: quatroNoCadastro(),
      fila: { "proposal.witnesses.set": [{ status: 422, body: { error: "teto_testemunhas", maximo: 4 } }] },
    });
    await t.fala("Envie a proposta");
    await t.fala("manter");
    const recusa = await t.fala("sim", "wamid.sim-1");
    expect(recusa.reply).toContain("máximo é de 4 testemunhas");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    // A lista que volta já não traz o mesmo conjunto marcado: só a obrigatória.
    expect(recusa.reply).toContain("1. ✅ Ana Testemunha (obrigatória)");
    expect(recusa.reply).toContain("2. ⬜ Beto Testemunha");
    // "manter" outra vez monta o cartão com o conjunto reduzido, nunca com o que acabou de falhar.
    const cartao = await t.fala("manter");
    expect(cartao.reply).toContain("Ana Testemunha");
    expect(cartao.reply).not.toContain("Beto Testemunha");
    await t.fala("sim", "wamid.sim-2");
    const w = t.de("proposal.witnesses.set");
    expect(w).toHaveLength(2);
    expect(w[1]!.args).toEqual({ proposta_id: "prop-1", testemunhas: [{ idPadrao: "c-1" }] });
    expect(w[1]!.chave).toBe("wamid.sim-2");
  });

  it("I2: o cartão das testemunhas avisa que substitui as atuais, inclusive as da tela", async () => {
    const t = montar();
    await t.fala("Envie a proposta");
    const cartao = await t.fala("sim");
    expect(cartao.reply).toContain("substitui as testemunhas atuais");
    expect(cartao.reply).toContain("adicionadas na tela");
    expect(t.de("proposal.witnesses.set")).toHaveLength(0);
  });

  it("testemunha_obrigatoria volta para a lista", async () => {
    const t = montar({ fila: { "proposal.witnesses.set": [{ status: 422, body: { error: "testemunha_obrigatoria" } }] } });
    await ateCartaoDeTestemunhas(t);
    const p = await t.fala("sim", "wamid.sim-testemunhas");
    expect(p.reply).toContain("Testemunhas desta proposta");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
  });

  it("as testemunhas gravadas usam a chave do SIM do cartão", async () => {
    const t = montar();
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    const w = t.de("proposal.witnesses.set");
    expect(w).toHaveLength(1);
    expect(w[0]!.chave).toBe("wamid.sim-testemunhas");
    expect(w[0]!.args).toMatchObject({ proposta_id: "prop-1" });
  });

  it("'salvar como padrão' responde com o link de Configurações e não grava", async () => {
    const t = montar();
    await t.fala("Envie a proposta");
    const p = await t.fala("salvar como padrão");
    expect(p.reply).toContain(LINK);
    expect(t.escritas()).toHaveLength(0);
  });

  it("conta sem Plus: o tipo indisponível não aparece e pedir por nome é recusado", async () => {
    const t = montar({
      options: optionsBody({
        tiposDeAssinatura: [
          { tipo: "email", disponivel: true, texto: "E-mail" },
          { tipo: "whatsapp", disponivel: false, motivo: "plano_sem_plus", texto: "WhatsApp" },
          { tipo: "aceite", disponivel: true, texto: "Aceite" },
        ],
      }),
    });
    await ateCartaoDeTestemunhas(t);
    const lista = await t.fala("sim", "wamid.sim-testemunhas");
    expect(lista.reply).not.toContain("WhatsApp");
    const p = await t.fala("whatsapp");
    expect(p.reply).toContain("não está disponível");
    expect(t.de("proposal.preflight")).toHaveLength(0);
  });

  it("409 documento_proprio: o aviso de perda de edição vem ANTES do SIM e o SIM manda regerar_documento:true", async () => {
    const t = montar({ fila: { "proposal.update": [{ status: 409, body: { error: "documento_proprio" } }] } });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("whatsapp");
    const aviso = await t.fala("sim", "wamid.sim-canal");
    expect(aviso.reply).toContain("Isso refaz o documento e apaga as edições feitas nele. Confirma? SIM/NÃO");
    expect(t.assinatura()).toMatchObject({ passo: "regerar" });
    expect(t.de("proposal.update")[0]!.args).not.toHaveProperty("regerar_documento");
    await t.fala("sim", "wamid.sim-regerar");
    const updates = t.de("proposal.update");
    expect(updates).toHaveLength(2);
    expect(updates[1]!.args).toEqual({ proposta_id: "prop-1", tipo_assinatura: "whatsapp", regerar_documento: true });
    expect(updates[1]!.chave).toBe("wamid.sim-regerar");
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
  });

  it("tipo Aceite sem celular do signatário pede o celular antes de qualquer preflight", async () => {
    const t = montar({
      options: optionsBody({
        tiposDeAssinatura: [
          { tipo: "email", disponivel: true, texto: "E-mail" },
          { tipo: "whatsapp", disponivel: true, texto: "WhatsApp" },
          { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite", assinantesSemCelular: [{ posicao: 1, papel: "proponente", nome: "Letícia Gonçalves" }] },
        ],
      }),
    });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    const p = await t.fala("aceite");
    expect(p.reply).toContain("Qual é o celular com DDD?");
    expect(p.reply).toContain("Letícia Gonçalves");
    expect(t.de("proposal.preflight")).toHaveLength(0);
    expect(t.assinatura()).toMatchObject({ passo: "celular" });
    // Trocar para e-mail volta ao fluxo normal.
    await t.fala("e-mail");
    expect(t.de("proposal.preflight")).toHaveLength(1);
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
  });

  it("o celular dito entra pelo condutor (ficha + SIM); só depois do SIM grava e o preflight segue", async () => {
    const semCelular = optionsBody({
      tiposDeAssinatura: [
        { tipo: "email", disponivel: true, texto: "E-mail" },
        { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite", assinantesSemCelular: [{ posicao: 1, papel: "proponente", nome: "Letícia Gonçalves" }] },
      ],
    });
    const t = montar({
      options: semCelular,
      optionsDepoisDeGravar: optionsBody({ tiposDeAssinatura: [{ tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" }] }),
      fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ACEITE }] },
    });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("aceite");
    const ficha = await t.fala("11 98765-4321");
    expect(ficha.reply).toMatch(/SIM/);
    expect(t.de("proposal.update")).toHaveLength(0); // só lido: nada gravado antes do SIM
    expect(t.de("proposal.preflight")).toHaveLength(0);
    await t.fala("sim", "wamid.sim-celular");
    const updates = t.de("proposal.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.chave).toBe("wamid.sim-celular");
    expect(t.de("proposal.preflight")).toHaveLength(1);
    expect(t.de("proposal.preflight")[0]!.args).toEqual({ proposta_id: "prop-1", tipo_assinatura: "aceite" });
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao", mostrado: { instrumento: "aceite" } });
    expect(t.de("proposal.send")).toHaveLength(0);
  });
});

describe("C1 (R24): o celular do Aceite só é gravado quando o papel tem UMA pessoa no rascunho", () => {
  const proponente = { nome: "Letícia Gonçalves", papel: "proponente" };
  const valter = { nome: "Valter Vendedor", papel: "vendedor" };
  const vera = { nome: "Vera Vendedora", papel: "vendedor" };
  const aceiteSemCelular = (assinantesSemCelular: Array<{ posicao: number; papel: string; nome: string }>) => [
    { tipo: "email", disponivel: true, texto: "E-mail" },
    { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite", assinantesSemCelular },
  ];
  const aceiteGravado = (signatarios: Array<{ nome: string; papel: string }>) =>
    optionsBody({ signatarios, tiposDeAssinatura: [{ tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" }] });

  // Negado primeiro.
  for (const [rotulo, signatarios] of [
    ["proponente, V1, V2", [proponente, valter, vera]],
    ["proponente, V2, V1 (embaralhado)", [proponente, vera, valter]],
    ["V2, proponente, V1 (embaralhado)", [vera, proponente, valter]],
  ] as const) {
    for (const falta of [valter, vera]) {
      it(`dois vendedores, ${falta.nome} sem celular, signatarios ${rotulo}: não grava, explica e manda para a tela`, async () => {
        const t = montar({
          options: optionsBody({ signatarios: [...signatarios], tiposDeAssinatura: aceiteSemCelular([{ posicao: 2, papel: "vendedor", nome: falta.nome }]) }),
        });
        await ateCartaoDeTestemunhas(t);
        const lista = await t.fala("sim", "wamid.sim-testemunhas");
        expect(lista.reply).toMatch(/aceite/i);
        const p = await t.fala("aceite");
        expect(p.reply).toContain(falta.nome);
        expect(p.reply).toMatch(/mais de um vendedor ou comprador/);
        expect(p.reply).toMatch(/pela tela/);
        expect(t.de("proposal.update")).toHaveLength(0);
        expect(t.de("proposal.preflight")).toHaveLength(0);
        expect(t.de("proposal.send")).toHaveLength(0);
      });
    }
  }

  it("vendedor único sem celular: pergunta e grava em vendedores[0]", async () => {
    const um = [proponente, valter];
    const t = montar({
      options: optionsBody({ signatarios: um, tiposDeAssinatura: aceiteSemCelular([{ posicao: 2, papel: "vendedor", nome: "Valter Vendedor" }]) }),
      optionsDepoisDeGravar: aceiteGravado(um),
      fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ACEITE }] },
    });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    const p = await t.fala("aceite");
    expect(p.reply).toContain("Valter Vendedor");
    await t.fala("11 98765-4321");
    await t.fala("sim", "wamid.sim-celular");
    const updates = t.de("proposal.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args).toEqual({ proposta_id: "prop-1", vendedores: [{ telefone: "11987654321" }] });
  });

  it("proponente único com `signatarios` embaralhado: grava em compradores[0]", async () => {
    const um = [valter, proponente];
    const t = montar({
      options: optionsBody({ signatarios: um, tiposDeAssinatura: aceiteSemCelular([{ posicao: 1, papel: "proponente", nome: "Letícia Gonçalves" }]) }),
      optionsDepoisDeGravar: aceiteGravado(um),
      fila: { "proposal.preflight": [{ status: 200, body: PRONTO_ACEITE }] },
    });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    await t.fala("aceite");
    await t.fala("11 98765-4321");
    await t.fala("sim", "wamid.sim-celular");
    expect(t.de("proposal.update")[0]!.args).toEqual({ proposta_id: "prop-1", compradores: [{ telefone: "11987654321" }] });
  });

  it("vendedor único com nome divergente: o Aceite continua na lista, a escolha explica e nada é gravado", async () => {
    const t = montar({
      options: optionsBody({
        signatarios: [proponente, valter],
        tiposDeAssinatura: [
          { tipo: "email", disponivel: true, texto: "E-mail" },
          { tipo: "aceite", disponivel: false, motivo: "assinante_sem_celular", assinantesSemCelular: [{ posicao: 2, papel: "vendedor", nome: "Fulano Que Não Está" }], texto: "Aceite" },
        ],
      }),
    });
    await ateCartaoDeTestemunhas(t);
    const lista = await t.fala("sim", "wamid.sim-testemunhas");
    expect(lista.reply).toMatch(/aceite/i);
    const p = await t.fala("aceite");
    expect(p.reply).toContain("Fulano Que Não Está");
    expect(p.reply).toMatch(/pela tela/);
    expect(t.de("proposal.update")).toHaveLength(0);
    expect(t.de("proposal.preflight")).toHaveLength(0);
  });

  it("uma pessoa gravável e outra não (testemunha): nada é perguntado antes de explicar", async () => {
    const t = montar({
      options: optionsBody({
        signatarios: [proponente, valter],
        tiposDeAssinatura: aceiteSemCelular([
          { posicao: 2, papel: "vendedor", nome: "Valter Vendedor" },
          { posicao: 4, papel: "testemunha", nome: "Dora Testemunha" },
        ]),
      }),
    });
    await ateCartaoDeTestemunhas(t);
    await t.fala("sim", "wamid.sim-testemunhas");
    const p = await t.fala("aceite");
    expect(p.reply).toContain("Dora Testemunha");
    expect(p.reply).toMatch(/pela tela/);
    expect(t.de("proposal.update")).toHaveLength(0);
  });
});

// ─── R21: o Flow de assinatura (Max) e o texto numerado (Newton) ────────────

describe("R21: o Flow de assinatura entra pelo condutor, com o token/nonce do C2", () => {
  const respostaDoFlow = "tipo_assinatura: email\ntestemunhas: t-1, t-2";

  async function comFlow() {
    vi.stubEnv("MAX_FLOW_ID_REVISAR_ASSINATURA", "FLOW_ASSINATURA");
    const t = montar();
    await t.fala("Envie a proposta", "wamid.abre");
    return t;
  }

  it("o Flow sai com o token fv2:assinatura:<nonce> e a lista numerada de corpo", async () => {
    const t = await comFlow();
    const flow = consumirFlowDoTurno("wamid.abre", T0 + 10_000);
    const nonce = t.assinatura()?.nonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(flow).toMatchObject({ tipo: "flow", flowId: "FLOW_ASSINATURA", flowToken: `fv2:assinatura:${nonce}` });
    expect(t.ultima!.reply).toContain("Testemunhas desta proposta");
    expect(t.escritas()).toHaveLength(0);
  });

  it("a resposta com o token certo só preenche o cartão: o SIM é que grava", async () => {
    const t = await comFlow();
    const nonce = t.assinatura()!.nonce!;
    const p = await t.fala(respostaDoFlow, "wamid.flow", `flow:fv2:assinatura:${nonce}`);
    expect(t.escritas()).toHaveLength(0);
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas_cartao", tipo: "email" });
    expect(p.reply).toContain("Ana Testemunha");
    expect(p.reply).toContain("Beto Testemunha");
    expect(p.reply).not.toContain("Caio Testemunha");
    await t.fala("sim", "wamid.sim-testemunhas");
    expect(t.de("proposal.witnesses.set")).toHaveLength(1);
    // O tipo veio do Flow: vai direto ao preflight (sem perguntar de novo).
    expect(t.assinatura()).toMatchObject({ passo: "envio_cartao" });
  });

  it("token de outro envio (antigo ou forjado): nada é anotado", async () => {
    const t = await comFlow();
    const p = await t.fala(respostaDoFlow, "wamid.flow", "flow:fv2:assinatura:OUTRO-NONCE-QUALQUER");
    expect(p.reply).toContain("não vale mais");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    expect(t.escritas()).toHaveLength(0);
  });

  it("resposta de Flow digitada à mão (sem token): nada é anotado", async () => {
    const t = await comFlow();
    const p = await t.fala(respostaDoFlow, "wamid.digitado");
    expect(p.reply).toContain("não veio do formulário desta etapa");
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    expect(t.escritas()).toHaveLength(0);
  });

  it("testemunha que não está no cadastro: a resposta é recusada inteira", async () => {
    const t = await comFlow();
    const nonce = t.assinatura()!.nonce!;
    await t.fala("tipo_assinatura: email\ntestemunhas: t-999", "wamid.flow", `flow:fv2:assinatura:${nonce}`);
    expect(t.assinatura()).toMatchObject({ passo: "testemunhas" });
    expect(t.escritas()).toHaveLength(0);
  });

  it("Newton nunca recebe Flow: só o texto numerado", async () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    vi.stubEnv("MAX_FLOW_ID_REVISAR_ASSINATURA", "FLOW_ASSINATURA");
    const t = montar();
    const p = await t.fala("Envie a proposta", "wamid.newton");
    expect(consumirFlowDoTurno("wamid.newton", T0 + 10_000)).toBeUndefined();
    expect(t.assinatura()?.nonce).toBeUndefined();
    expect(p.reply).toMatch(/^1\. /m);
  });
});
