/**
 * O ImobPro SIMULADO das baterias com modelo real (`eval-respostas.eval.ts` e
 * `eval-golden.eval.ts`). Nada é escrito em lugar nenhum: o estado vive em `S`
 * e é zerado por `reiniciar()` a cada conversa.
 *
 * Extraído de `eval-respostas.eval.ts` sem mudar o comportamento dos verbos que
 * ela já usava (proposal.*, form.*, credit.*, lead.upsert). Os verbos novos
 * (captacao.*, proposal.send, e as leituras `consultaGolden`) só respondem no
 * golden: no restante o simulador continua devolvendo `nao_simulado`.
 *
 * Dados 100% sintéticos (nomes "TESTE", telefone 11999990000).
 */

export type Prop = { id: string; codigo: string; titulo: string; status: string; estado: string; signatarios: { nome: string; status: string }[] };
export type EnvioSim = "aprovado" | "sem_resposta";
type LeadSim = { id: string; nome: string; cpf: string; credito: Record<string, Record<string, unknown>> };
type Cap = { id: string; codigo: string; nome: string; tipo: string; modeloId: string; version: number; status: "rascunho" | "em_assinatura"; dados: Record<string, unknown> };
export type Negocio = { id: string; titulo: string; etapa: string; valor: number; paradoHaDias: number };

export const BASE: Prop[] = [
  { id: "p1", codigo: "PROP-2026-0011", titulo: "Apto 302 Rua das Flores", status: "assinada_proponente", estado: "Assinada pelo proponente", signatarios: [{ nome: "Letícia Moraes", status: "assinou" }] },
  { id: "p2", codigo: "PROP-2026-0012", titulo: "Casa Jardim Europa", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "Letícia Andrade", status: "pendente" }] },
  { id: "p3", codigo: "PROP-2026-0013", titulo: "Sala comercial Centro", status: "enviada", estado: "Enviada", signatarios: [{ nome: "Carlos Pereira", status: "pendente" }] },
  { id: "p4", codigo: "PROP-2026-0014", titulo: "Cobertura Av. Atlântica 1500", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "Renato Lima", status: "pendente" }] },
];
/** Cenário do golden: a PROP-2026-0003 (rascunho) existe e tem um comprador de teste. */
export const BASE_GOLDEN: Prop[] = [
  ...BASE,
  { id: "p0003", codigo: "PROP-2026-0003", titulo: "Apto TESTE Rua Teste 30", status: "rascunho", estado: "Rascunho", signatarios: [{ nome: "TESTE Comprador", status: "pendente" }] },
];
/** Cinco primeiros são os mais recentes; TESTE1 NÃO é o item 1 (separa "TESTE1" de "item 1"). */
export const NEGOCIOS_GOLDEN: Negocio[] = [
  { id: "dn-parado-a", titulo: "TESTE parado A", etapa: "Proposta", valor: 410000, paradoHaDias: 41 },
  { id: "dn-assinatura-4", titulo: "TESTE assinatura 4", etapa: "Assinatura", valor: 480000, paradoHaDias: 3 },
  { id: "dn-teste1", titulo: "TESTE1", etapa: "Formulário", valor: 500000, paradoHaDias: 9 },
  { id: "dn-assinatura-2", titulo: "TESTE assinatura 2", etapa: "Assinatura", valor: 450000, paradoHaDias: 5 },
  { id: "dn-parado-b", titulo: "TESTE parado B", etapa: "Contrato", valor: 390000, paradoHaDias: 33 },
  { id: "dn-parado-c", titulo: "TESTE parado C", etapa: "Proposta", valor: 370000, paradoHaDias: 28 },
  { id: "dn-parado-d", titulo: "TESTE parado D", etapa: "Formulário", valor: 360000, paradoHaDias: 22 },
];

export const S = {
  props: [] as Prop[],
  seq: 0,
  leadsCredito: [] as LeadSim[],
  envio: null as EnvioSim | null,
  captacoes: [] as Cap[],
  negocios: [] as Negocio[],
};

export function reiniciar(opts: { golden?: boolean; envio?: EnvioSim | null } = {}) {
  const base = opts.golden ? BASE_GOLDEN : BASE;
  S.props = base.map((p) => ({ ...p, signatarios: p.signatarios.map((s) => ({ ...s })) }));
  S.leadsCredito = [];
  S.envio = opts.envio ?? null;
  S.captacoes = [];
  S.negocios = opts.golden ? NEGOCIOS_GOLDEN.map((n) => ({ ...n })) : [];
  S.seq = 0;
}

const EDITAVEIS = new Set(["rascunho", "aguardando_aprovacao", "falha_envio"]);
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = (p: Prop) => norm(`${p.codigo} ${p.titulo} ${p.signatarios.map((s) => s.nome).join(" ")}`).split(/[^a-z0-9]+/).filter(Boolean);
const semZeros = (x: string) => x.replace(/^0+(?=\d)/, "");
const casa = (p: Prop, busca: string) => norm(busca).split(/[^a-z0-9]+/).filter(Boolean).every((w) =>
  palavras(p).some((q) => (/^\d+$/.test(w) ? /^\d+$/.test(q) && semZeros(q) === semZeros(w) : q === w || (w.length >= 4 && q.startsWith(w)))));
const achar = (a: Record<string, unknown>) => S.props.find((p) => p.id === a.proposta_id || p.id === a.id || p.codigo === String(a.codigo ?? "").toUpperCase());
const pdf = { link: "https://app.imobpro.test/p/rascunho.pdf", expiraEm: new Date(Date.now() + 2 * 3600e3).toISOString() };
export const lista = (a: Record<string, unknown>) => {
  const b = typeof a.busca === "string" ? a.busca : null;
  const items = b ? S.props.filter((p) => casa(p, b)) : S.props;
  return { items: items.slice(0, 10), total: items.length, ...(b ? { busca: norm(b) } : {}) };
};

// Crédito (M2): leads da ficha, simulados como o C5 responde.
const ORDEM_FICHA: [string, string, string][] = [
  ["pretendente", "documento", "CPF do pretendente"], ["pretendente", "nomeCompleto", "Nome completo do pretendente"],
  ["pretendente", "vinculoEmpregaticio", "Vínculo empregatício do pretendente"], ["pretendente", "profissao", "Profissão do pretendente"],
  ["pretendente", "rendaMensal", "Renda mensal do pretendente"], ["locacao", "valorAluguel", "Valor do aluguel"],
  ["locacao", "valorCondominio", "Valor do condomínio"], ["locacao", "valorIptu", "Valor do IPTU"],
  ["locacao", "vaiMorar", "Se o pretendente vai morar no imóvel"],
];
const faltantesSim = (c: LeadSim["credito"]) => ORDEM_FICHA.filter(([g, k]) => c[g]?.[k] === undefined).map(([, , r]) => r);
function creditoSim(verb: string, a: Record<string, unknown>): { status: number; body: Record<string, unknown> } | null {
  if (verb === "credit.preflight") {
    const l = S.leadsCredito.find((x) => x.id === a.leaseClientId);
    return { status: 200, body: { configurado: true, orgLigada: true, custoCents: 1500, consentimento: !!l, faltantes: l ? faltantesSim(l.credito) : faltantesSim({}), avisos: [], lead: l ? { id: l.id, nome: l.nome, status: "novo" } : null } };
  }
  if (verb === "lead.upsert") {
    const cpf = String(a.cpf ?? "").replace(/\D/g, "");
    if (cpf.length !== 11) return { status: 422, body: { error: "documento_invalido" } };
    let l = S.leadsCredito.find((x) => x.cpf === cpf);
    if (!l) {
      if (typeof a.nome !== "string") return { status: 422, body: { error: "nome_obrigatorio" } };
      l = { id: `lc${S.leadsCredito.length + 1}`, nome: a.nome, cpf, credito: {} };
      S.leadsCredito.push(l);
    }
    for (const [g, v] of Object.entries((a.campos ?? {}) as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) l.credito[g] = { ...(l.credito[g] ?? {}), ...(v as Record<string, unknown>) };
    }
    return { status: 200, body: { id: l.id, status: "novo", faltantes: faltantesSim(l.credito) } };
  }
  if (verb === "credit.request") {
    // Simulado (M3): nada sai daqui; a decisão é fixa.
    return { status: 200, body: { requestId: "r1", decision: "aprovado", rotulo: "Aprovado", justificativa: "Bom histórico de pagamentos",
      podePedirHumanizada: false, leadLink: `/locacao/pessoas/clientes/${String(a.leaseClientId ?? "lc1")}` } };
  }
  if (verb === "credit.status") {
    const nome = String(a.nome ?? "").toLowerCase();
    if (!nome.startsWith("let")) return { status: 404, body: { error: "nao_encontrada" } };
    return { status: 200, body: { lead: { id: "lc9", nome: "Letícia Andrade", status: "em_analise" },
      ultima: { rotulo: "Em análise", createdAt: "2026-10-10T15:00:00.000Z", completedAt: null }, link: "/locacao/pessoas/clientes/lc9" } };
  }
  return null;
}

// Captação (golden): versão compacta do fake de `src/graph/__tests__/captacao.test.ts`.
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const MODELO_CAPTACAO = { id: "t1", nome: "Modelo de venda" };
function mesclarPorId(atual: Record<string, unknown>[] = [], novo: Record<string, unknown>[] = []) {
  const out = [...atual];
  for (const n of novo) {
    const i = out.findIndex((x) => x.id === n.id);
    if (i >= 0) out[i] = { ...out[i], ...n }; else out.push(n);
  }
  return out;
}
function faltantesDeCaptacao(c: Cap) {
  const d = c.dados, im = obj(d.imovel), co = obj(d.condicoes);
  const f: { path: string; rotulo: string; etapa: string; proprietarioId?: string }[] = [];
  if (!im.rua || !im.numero) f.push({ path: "imovel.endereco", rotulo: "Endereço do imóvel", etapa: "imovel" });
  if (!im.matricula) f.push({ path: "imovel.matricula", rotulo: "Matrícula", etapa: "imovel" });
  for (const p of (d.proprietarios as Record<string, unknown>[] | undefined) ?? []) {
    if (!p.cpf && !p.cnpj) f.push({ path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: String(p.id) });
  }
  if (!(d.proprietarios as unknown[] | undefined)?.length) f.push({ path: "proprietarios[].nome", rotulo: "Nome completo", etapa: "proprietarios" });
  if (c.tipo === "venda" && co.valor === undefined) f.push({ path: "condicoes.valor", rotulo: "Valor de venda", etapa: "condicoes" });
  if (co.comissao_percent === undefined) f.push({ path: "condicoes.comissao_percent", rotulo: "Comissão", etapa: "condicoes" });
  if (co.prazo_dias === undefined) f.push({ path: "condicoes.prazo_dias", rotulo: "Prazo da autorização (dias)", etapa: "condicoes" });
  return f;
}
const estadoDe = (c: Cap) => (c.status === "rascunho" ? "Rascunho" : "Em assinatura");
function captacaoSim(verb: string, a: Record<string, unknown>, idempotencyKey?: string): { status: number; body: Record<string, unknown> } | null {
  switch (verb) {
    case "captacao.options": {
      const base = { esteiras: ["venda", "locacao"], canais: { email: true, whatsapp: true, aceite: false }, assinaturaConfigurada: true };
      if (typeof a.captacaoId === "string") {
        const c = S.captacoes.find((x) => x.id === a.captacaoId);
        if (!c) return { status: 404, body: { error: "nao_encontrada" } };
        const donos = (c.dados.proprietarios as Record<string, unknown>[] | undefined) ?? [];
        return { status: 200, body: { ...base, modelos: [], assinantes: donos.map((d) => ({ nome: d.nome, papel: "proprietario", canal: "email", assina: true })) } };
      }
      return { status: 200, body: { ...base, modelos: [MODELO_CAPTACAO] } };
    }
    case "captacao.create": {
      if (!idempotencyKey) return { status: 400, body: { error: "idempotency_key_obrigatoria" } };
      if (typeof a.captacaoId === "string") {
        const c = S.captacoes.find((x) => x.id === a.captacaoId);
        if (!c) return { status: 404, body: { error: "nao_encontrada" } };
        if (typeof a.version !== "number") return { status: 400, body: { error: "version_obrigatoria" } };
        if (a.version !== c.version) return { status: 409, body: { error: "versao_desatualizada" } };
        const dados = obj(a.dados);
        c.dados = {
          ...c.dados,
          ...(dados.imovel ? { imovel: { ...obj(c.dados.imovel), ...obj(dados.imovel) } } : {}),
          ...(dados.condicoes ? { condicoes: { ...obj(c.dados.condicoes), ...obj(dados.condicoes) } } : {}),
          ...(dados.proprietarios ? { proprietarios: mesclarPorId(c.dados.proprietarios as never, dados.proprietarios as never) } : {}),
        };
        c.version += 1;
        return { status: 200, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: estadoDe(c), version: c.version } } };
      }
      if (typeof a.nome !== "string" || !a.nome.trim()) return { status: 400, body: { error: "nome_obrigatorio" } };
      if (a.tipo !== "venda" && a.tipo !== "locacao") return { status: 400, body: { error: "tipo_invalido" } };
      const c: Cap = { id: `cap-${S.captacoes.length + 1}`, codigo: `CAP-2026-000${S.captacoes.length + 1}`, nome: a.nome, tipo: String(a.tipo),
        modeloId: MODELO_CAPTACAO.id, version: 0, status: "rascunho", dados: obj(a.dados) };
      S.captacoes.push(c);
      return { status: 201, body: { captacao: { id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: "Rascunho", version: 0 }, modelo: MODELO_CAPTACAO, link: `/imoveis/captacoes/${c.id}` } };
    }
    case "captacao.preflight": {
      const c = S.captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (c.status !== "rascunho") return { status: 409, body: { error: "nao_e_rascunho", estado: estadoDe(c) } };
      const faltantes = faltantesDeCaptacao(c);
      return { status: 200, body: { captacaoId: c.id, version: c.version, modelo: { id: c.modeloId, nome: MODELO_CAPTACAO.nome }, pronto: faltantes.length === 0, faltantes, bloqueios: [], emBranco: 0 } };
    }
    case "captacao.send": {
      if (!idempotencyKey) return { status: 400, body: { error: "idempotency_key_obrigatoria" } };
      const c = S.captacoes.find((x) => x.id === a.captacaoId);
      if (!c) return { status: 404, body: { error: "nao_encontrada" } };
      if (a.version !== c.version) return { status: 409, body: { error: "versao_desatualizada" } };
      c.status = "em_assinatura";
      return { status: 200, body: { ok: true, estado: "Em assinatura", instrumento: "envelope", pessoas: 1, retomado: false, link: `/imoveis/captacoes/${c.id}` } };
    }
    case "captacao.list": {
      let l = S.captacoes;
      if (typeof a.captacaoId === "string") l = l.filter((c) => c.id === a.captacaoId);
      const items = l.map((c, i) => ({ ref: i + 1, id: c.id, codigo: c.codigo, nome: c.nome, esteira: c.tipo, estado: estadoDe(c), tom: "info", link: `/imoveis/captacoes/${c.id}` }));
      return { status: 200, body: { items, total: items.length } };
    }
    default: return null;
  }
}

/** `ehGolden`: liga captacao.* e proposal.send simulados (fora do golden seguem `nao_simulado`, como antes). */
export async function imobpro({ verb, args = {}, idempotencyKey }: { verb: string; args?: Record<string, unknown>; idempotencyKey?: string }, ehGolden = false): Promise<{ status: number; body: Record<string, unknown> }> {
  const credito = creditoSim(verb, args);
  if (credito) return credito;
  if (ehGolden) {
    const cap = captacaoSim(verb, args, idempotencyKey);
    if (cap) return cap;
  }
  const p = achar(args);
  switch (verb) {
    case "proposal.list": return { status: 200, body: lista(args) };
    case "proposal.status": return p ? { status: 200, body: { proposta: p } } : { status: 404, body: { error: "nao_encontrada" } };
    case "proposal.complete": return { status: 200, body: { status: "completa" } };
    case "proposal.convert": return { status: 201, body: { negocio: { id: "d1", link: "https://app.imobpro.test/deals/d1" }, formulario: { id: "f1", link: "https://app.imobpro.test/f/abc" } } };
    case "proposal.delete":
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      if (p.status === "enviada") return { status: 409, body: { error: "ja_enviada" } };
      S.props = S.props.filter((x) => x !== p);
      return { status: 200, body: { ok: true, proposta: { codigo: p.codigo } } };
    case "proposal.duplicate": {
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      const novo = { ...p, id: `n${++S.seq}`, codigo: `PROP-2026-00${20 + S.seq}`, status: "rascunho", estado: "Rascunho" };
      S.props.push(novo);
      return { status: 201, body: { proposta: { id: novo.id, codigo: novo.codigo, status: "rascunho" }, origem: { codigo: p.codigo } } };
    }
    case "proposal.update":
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      if (!EDITAVEIS.has(p.status)) return { status: 409, body: { error: "nao_editavel", estado: p.estado } };
      return { status: 200, body: { proposta: { id: p.id, codigo: p.codigo }, pdf } };
    case "proposal.create": {
      const novo: Prop = { id: `c${++S.seq}`, codigo: `PROP-2026-00${40 + S.seq}`, titulo: "Nova", status: "rascunho", estado: "Rascunho", signatarios: [] };
      S.props.push(novo);
      return { status: 201, body: { proposal: { id: novo.id, code: novo.codigo }, proposta: { id: novo.id, codigo: novo.codigo }, pdf } };
    }
    case "proposal.options":
      return { status: 200, body: { assinaturaConfigurada: true, metodos: [{ valor: "whatsapp", rotulo: "WhatsApp" }, { valor: "email", rotulo: "E-mail" }], signatarios: p?.signatarios.map((s) => ({ nome: s.nome, papel: "proponente" })) ?? [] } };
    case "proposal.preflight": return { status: 200, body: { ok: true, modelo: true, assinaturaConfigurada: true } };
    case "proposal.send":
      if (!ehGolden) return { status: 501, body: { error: `nao_simulado:${verb}` } };
      if (!p) return { status: 404, body: { error: "nao_encontrada" } };
      if (!EDITAVEIS.has(p.status)) return { status: 409, body: { error: "nao_editavel", estado: p.estado } };
      p.status = "enviada"; p.estado = "Enviada";
      return { status: 200, body: { ok: true, proposta: { id: p.id, codigo: p.codigo }, estado: "Enviada" } };
    case "form.options": return { status: 200, body: { campos: [], gerente: { obrigatorio: false }, titulo: { padrao: false } } };
    case "form.create": return { status: 201, body: { formulario: { id: "f-eval", link: "https://app.imobpro.test/f/eval" }, negocio: { id: "d-eval", link: "https://app.imobpro.test/deals/d-eval" } } };
    default: return { status: 501, body: { error: `nao_simulado:${verb}` } };
  }
}

/**
 * Leituras (`scope-query`) do golden. Os formatos de item seguem o que as tools
 * numeram (`id`, `titulo`, ...); o contrato exato do servidor não está neste
 * repo, então os campos além de `id`/`titulo`/`etapa`/`valor` são inferidos.
 * Negado no servidor (pending.summary de um negócio sem acesso) volta `[]`,
 * que o despachante transforma em `{sem_permissao:true}`.
 */
export function consultaGolden({ verb, args = {} }: { verb: string; args?: Record<string, unknown> }): { items: unknown[]; truncated: boolean } {
  const ITENS = 5;
  switch (verb) {
    case "proposal.list": {
      const l = lista(args);
      const equipe = args.escopo === "equipe";
      return { items: l.items, truncated: equipe ? true : l.total > l.items.length };
    }
    case "deal.list": {
      const items = [...S.negocios].map(({ paradoHaDias, ...n }) => ({ ...n, paradoHaDias }));
      return { items: items.slice(0, 10), truncated: items.length > ITENS };
    }
    case "deal.pending": {
      const items = S.negocios.filter((n) => n.etapa === "Assinatura").map((n) => ({ id: n.id, titulo: n.titulo, etapa: n.etapa, pendencias: ["Assinatura do comprador"] }));
      return { items, truncated: false };
    }
    case "pending.summary": {
      if (typeof args.dealId === "string") return { items: [], truncated: false };
      return { items: [{ formularios: { total: 1, itens: [] }, propostas: { total: 2, itens: [] }, atividades: { total: 0, itens: [] } }], truncated: false };
    }
    case "contract.status": {
      const n = S.negocios.find((x) => x.id === args.negocio_id);
      if (!n) return { items: [], truncated: false };
      return { items: [{ id: n.id, titulo: n.titulo, estado: n.etapa === "Assinatura" ? "Em assinatura" : "Sem contrato", versao: n.etapa === "Assinatura" ? 2 : null }], truncated: false };
    }
    case "metrics.get":
      return { items: [{ periodo: args.periodo ?? "agora", escopo: "organizacao", totais: { negociosNovos: 9, negociosGanhos: 2, propostasEnviadas: 12, propostasAceitas: 5, propostasRecusadas: 1, captacoesNovas: 3, captacoesAssinadas: 1 }, linhas: [], quebraNegada: false }], truncated: false };
    default: return { items: [], truncated: false };
  }
}
