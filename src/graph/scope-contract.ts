/**
 * O contrato do `POST /api/agents/scope-query` do ImobPro — a metade daqui.
 *
 * **Sem consumidor, de propósito.** A regra 2 da governança do Max
 * (`contractmaker/CLAUDE.md`) manda o receptor entrar antes, inerte: o cliente
 * de verdade (`src/lib/scope.ts`) e o nó `tools` que o usa são o PR 6. O que
 * este arquivo entrega hoje é o TIPO e o VETOR, para que a divergência de
 * contrato apareça em teste vermelho no dia em que ela nascer, e não meses
 * depois numa conversa errada.
 *
 * ── Por que este contrato precisa de vetor tanto quanto o do HMAC ─────────
 *
 * O modo de falha do HMAC é barulhento: 401 em toda chamada, e alguém percebe.
 * O deste é **silencioso e assimétrico**, e pior que o da política: se o ImobPro
 * renomear `referencia` para `ref`, este lado lê `undefined` e o Max passa a
 * falar de "negócio undefined" — feio, mas visível. Se o ImobPro **acrescentar**
 * um campo à projeção do broker, nada aqui quebra e o vazamento entra em
 * produção sem uma linha vermelha em lugar nenhum.
 *
 * Por isso o vetor do broker abaixo é afirmado por **AUSÊNCIA** também deste
 * lado: são duas chaves iguais em dois cofres, e a leitura de um não substitui
 * a do outro.
 *
 * O literal é literal de propósito, e não montado a partir dos tipos: um
 * fixture derivado do próprio código acompanharia a renomeação em silêncio, que
 * é o defeito que ele deveria pegar.
 */

/** O sujeito da leitura. O corretor comissionado NÃO é `User`. */
export type ScopeSubject =
  | { kind: "user"; userId: string }
  | { kind: "broker"; splitRecipientId: string };

/** Os verbos de leitura. Espelha `VERBOS_DE_LEITURA` do ImobPro. */
export const VERBOS_DE_LEITURA = [
  "deal.list",
  "deal.detail",
  "deal.pending",
  "proposal.list",
  "proposal.detail",
  "notification.list",
  "activity.list",
  "activity.get",
  "metrics.get",
  "property.list",
  "property.detail",
  "contract.status",
  "template.decisions",
  /** Pendências e avisos (24/10/2026): formulários, propostas e atividades pendentes. */
  "pending.summary",
  /** Situação das certidões de UM negócio ou proposta (PR-O4b, 16/11/2026). Só usuário; corretor recebe `{items:[]}`. */
  "certidao.status",
  /** Documentos de UM negócio ou proposta (PR-O4c, 16/11/2026). Só usuário; corretor recebe `{items:[]}`. Só metadado: nunca arquivo nem URL. */
  "document.list",
  /** Cobranças de comissão de UM negócio (PR-O4d, 16/11/2026). Só usuário e só leitura; corretor recebe `{items:[]}`. Nunca link, boleto nem PIX. */
  "charge.status",
] as const;

export type ScopeQueryVerb = (typeof VERBOS_DE_LEITURA)[number];

/**
 * Os status de `Proposal` — espelha o `ProposalStatus` de
 * `contractmaker/apps/web/src/lib/proposals/status.ts`.
 *
 * Existe porque `Proposal.status` é `String` no banco, não enum: um `estado`
 * inventado pelo modelo ("todas", "pendente") NÃO dá erro no servidor — vira
 * `where.status = "todas"`, lista vazia, e o Max afirma "você não tem
 * propostas". Filtro fora desta lista é descartado no cliente (`limparArgs`).
 */
export const ESTADOS_DE_PROPOSTA = [
  "rascunho",
  "aguardando_aprovacao",
  "enviada",
  "entregue",
  "visualizada",
  "assinada_proponente",
  "aguardando_vendedor",
  "completa",
  "convertida",
  "recusada_proponente",
  "recusada_vendedor",
  "expirada",
  "cancelada",
  "falha_envio",
] as const;

/**
 * `metrics.get`: períodos e quebras que o ImobPro entende (par do contractmaker,
 * plano notificações por papel PR6/v3). Receptor inerte: sem `periodo` a resposta
 * segue sendo os totais de agora.
 */
export const PERIODOS_DE_METRICA = ["hoje", "ontem", "7d", "30d", "mes", "mes_passado"] as const;
export const QUEBRAS_DE_METRICA = ["corretor", "equipe", "departamento"] as const;

export interface ScopeQueryRequest {
  verb: ScopeQueryVerb;
  subject: ScopeSubject;
  /**
   * Obrigatório, e VALIDA o `subject`: o servidor refaz o vínculo
   * telefone→sujeito. Divergência é 403, não lista vazia.
   */
  phone: string;
  args?: {
    estado?: string;
    limite?: number;
    negocio_id?: string;
    proposta_id?: string;
    imovel_id?: string;
    cursor?: string;
    /** `activity.list`: recorte pedido (par do contractmaker PR11). */
    filtro?: "minhas" | "atrasadas" | "hoje";
    /** `activity.get`. */
    atividade_id?: string;
    /**
     * `pending.summary`: blocos pedidos (ausente = os três de sempre). `avisos` só sai quando
     * pedido por nome, com a capability `pending.avisos`, e nunca junto de `dealId`.
     */
    blocos?: ("formularios" | "propostas" | "atividades" | "avisos")[];
    /** `pending.summary`: restringe os formulários a este negócio. */
    dealId?: string;
    /** `metrics.get`: período pedido (par do contractmaker, plano notificações por papel PR6/v3). */
    periodo?: (typeof PERIODOS_DE_METRICA)[number];
    /** `metrics.get`: quebra pedida por gestor (par do contractmaker, plano notificações por papel PR6/v3). */
    quebra?: (typeof QUEBRAS_DE_METRICA)[number];
    /**
     * `deal.list`: nome do negócio ou do cliente (1 a 80 caracteres depois do trim; o servidor soma ao escopo
     * e procura em título OU cliente, sem diferenciar maiúsculas). Só o USUÁRIO manda: o corretor comissionado
     * nunca envia o termo (e recebe `{items:[]}` se ele chegasse). Um CM antigo o ignora: o Max refiltra.
     */
    busca?: string;
  };
}

/** O que o USUÁRIO da plataforma recebe. */
export interface DealProjetadoUser {
  id: string;
  etapa: string | null;
  pendencias: string[];
  atualizadoEm: string;
  titulo: string;
  cliente: string | null;
  valor: number | null;
}

/**
 * O que o CORRETOR COMISSIONADO recebe — menos campos, mesmo verbo.
 *
 * Sem `titulo` (carrega endereço), sem `cliente`, sem `valor`. `referencia`
 * existe porque ele precisa dizer DE QUAL negócio fala sem que a plataforma lhe
 * entregue o endereço.
 */
export interface DealProjetadoBroker {
  id: string;
  etapa: string | null;
  pendencias: string[];
  atualizadoEm: string;
  referencia: string;
}

/** A assinatura do contrato principal: só contagens, nunca o signatário individual. */
export interface AssinaturaDoUser {
  estado: string;
  enviadoEm: string | null;
  concluidoEm: string | null;
  total: number;
  assinadas: number;
  recusadas: number;
  pendentes: number;
}

/**
 * `deal.detail` do USUÁRIO (PR-O4a, par do contractmaker#3167): as 7 chaves de `deal.list`, na
 * mesma ordem, e as 6 novas. `contrato`/`proposta`/`assinatura` são `null` quando não há.
 * `proposta.id` e `id` existem no fio e NUNCA chegam ao modelo nem à pessoa.
 */
export interface DealDetalhadoUser extends DealProjetadoUser {
  tipo: "venda" | "locacao";
  partes: { papel: string; nome: string }[];
  contrato: { estado: string; versao: number; atualizadoEm: string } | null;
  proposta: { id: string; codigo: string | null; estado: string } | null;
  assinatura: AssinaturaDoUser | null;
  link: string;
}

/**
 * `deal.detail` do CORRETOR COMISSIONADO: só PAPEL das partes (nome identifica o cliente), sem
 * `proposta` (não tem trilha de proposta), sem `link`, sem datas de envio.
 */
export interface DealDetalhadoBroker extends DealProjetadoBroker {
  partes: { papel: string }[];
  contrato: { estado: string } | null;
  assinatura: { estado: string; total: number; assinadas: number; recusadas: number; pendentes: number } | null;
}

const CHAVES_USER = [
  "id", "etapa", "pendencias", "atualizadoEm", "titulo", "cliente", "valor",
  "tipo", "partes", "contrato", "proposta", "assinatura", "link",
] as const;
const CHAVES_BROKER = [
  "id", "etapa", "pendencias", "atualizadoEm", "referencia", "partes", "contrato", "assinatura",
] as const;
const CHAVES_ASSINATURA_USER = ["estado", "enviadoEm", "concluidoEm", "total", "assinadas", "recusadas", "pendentes"] as const;
const CHAVES_ASSINATURA_BROKER = ["estado", "total", "assinadas", "recusadas", "pendentes"] as const;

type Objeto = Record<string, unknown>;

const ehObjeto = (v: unknown): v is Objeto => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * O objeto tem TODAS estas chaves (faltou uma, a forma não é a do contrato). Chave a MAIS é
 * tolerada de propósito: o contrato é aditivo, e o objeto devolvido é montado só com a allowlist.
 */
const temChaves = (v: Objeto, chaves: readonly string[]): boolean => chaves.every((c) => Object.hasOwn(v, c));
const texto = (v: unknown): v is string => typeof v === "string";
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";
const contagem = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function lerAssinatura(v: unknown, chaves: readonly string[], user: boolean): boolean {
  if (!ehObjeto(v) || !temChaves(v, chaves)) return false;
  if (!texto(v.estado)) return false;
  if (!(contagem(v.total) && contagem(v.assinadas) && contagem(v.recusadas) && contagem(v.pendentes))) return false;
  return !user || (textoOuNulo(v.enviadoEm) && textoOuNulo(v.concluidoEm));
}

/**
 * Lê UM item de `deal.detail` como o contrato diz, ou devolve `null`.
 *
 * **Allowlist que monta, fail-closed no que falta.** Chave OBRIGATÓRIA ausente ou de tipo errado em
 * QUALQUER nível descarta o item inteiro (ausência que alguém investiga, não item meio-certo).
 * Chave a MAIS (um `cpf`, um `email`, um `nome` na parte do broker, ou um campo aditivo legítimo
 * do CM) NÃO derruba o item: é REMOVIDA, porque o objeto devolvido é NOVO, montado campo a campo
 * só com o que o contrato lista; o que o servidor mandar além disso nunca é copiado, nem por
 * referência, e portanto nunca é renderizado. Vale para os DOIS sujeitos. A forma do broker lida
 * como usuário (ou o inverso) continua recusada, pois falta chave obrigatória (`referencia`/`titulo`).
 */
export function lerDealDetalhado(item: unknown, kind: "user"): DealDetalhadoUser | null;
export function lerDealDetalhado(item: unknown, kind: "broker"): DealDetalhadoBroker | null;
export function lerDealDetalhado(item: unknown, kind: "user" | "broker"): DealDetalhadoUser | DealDetalhadoBroker | null;
export function lerDealDetalhado(item: unknown, kind: "user" | "broker"): DealDetalhadoUser | DealDetalhadoBroker | null {
  if (!ehObjeto(item)) return null;
  const user = kind === "user";
  if (!temChaves(item, user ? CHAVES_USER : CHAVES_BROKER)) return null;

  if (!(texto(item.id) && textoOuNulo(item.etapa) && texto(item.atualizadoEm))) return null;
  if (!Array.isArray(item.pendencias) || !item.pendencias.every(texto)) return null;
  if (!Array.isArray(item.partes)) return null;
  const pendencias = [...(item.pendencias as string[])];

  if (user) {
    if (!(texto(item.titulo) && textoOuNulo(item.cliente) && texto(item.link))) return null;
    if (!(item.valor === null || (typeof item.valor === "number" && Number.isFinite(item.valor)))) return null;
    if (item.tipo !== "venda" && item.tipo !== "locacao") return null;

    const partes: DealDetalhadoUser["partes"] = [];
    for (const p of item.partes) {
      if (!ehObjeto(p) || !temChaves(p, ["papel", "nome"]) || !texto(p.papel) || !texto(p.nome)) return null;
      partes.push({ papel: p.papel, nome: p.nome });
    }

    let contrato: DealDetalhadoUser["contrato"] = null;
    if (item.contrato !== null) {
      const c = item.contrato;
      if (!ehObjeto(c) || !temChaves(c, ["estado", "versao", "atualizadoEm"])) return null;
      if (!(texto(c.estado) && contagem(c.versao) && texto(c.atualizadoEm))) return null;
      contrato = { estado: c.estado, versao: c.versao, atualizadoEm: c.atualizadoEm };
    }

    let proposta: DealDetalhadoUser["proposta"] = null;
    if (item.proposta !== null) {
      const p = item.proposta;
      if (!ehObjeto(p) || !temChaves(p, ["id", "codigo", "estado"])) return null;
      if (!(texto(p.id) && textoOuNulo(p.codigo) && texto(p.estado))) return null;
      proposta = { id: p.id, codigo: p.codigo, estado: p.estado };
    }

    let assinatura: DealDetalhadoUser["assinatura"] = null;
    if (item.assinatura !== null) {
      if (!lerAssinatura(item.assinatura, CHAVES_ASSINATURA_USER, true)) return null;
      const a = item.assinatura as unknown as AssinaturaDoUser;
      assinatura = {
        estado: a.estado,
        enviadoEm: a.enviadoEm,
        concluidoEm: a.concluidoEm,
        total: a.total,
        assinadas: a.assinadas,
        recusadas: a.recusadas,
        pendentes: a.pendentes,
      };
    }

    return {
      id: item.id,
      etapa: item.etapa,
      pendencias,
      atualizadoEm: item.atualizadoEm,
      titulo: item.titulo,
      cliente: item.cliente,
      valor: item.valor,
      tipo: item.tipo,
      partes,
      contrato,
      proposta,
      assinatura,
      link: item.link,
    };
  }

  if (!texto(item.referencia)) return null;
  const partes: DealDetalhadoBroker["partes"] = [];
  for (const p of item.partes) {
    if (!ehObjeto(p) || !temChaves(p, ["papel"]) || !texto(p.papel)) return null;
    partes.push({ papel: p.papel });
  }

  let contrato: DealDetalhadoBroker["contrato"] = null;
  if (item.contrato !== null) {
    const c = item.contrato;
    if (!ehObjeto(c) || !temChaves(c, ["estado"]) || !texto(c.estado)) return null;
    contrato = { estado: c.estado };
  }

  let assinatura: DealDetalhadoBroker["assinatura"] = null;
  if (item.assinatura !== null) {
    if (!lerAssinatura(item.assinatura, CHAVES_ASSINATURA_BROKER, false)) return null;
    const a = item.assinatura as unknown as NonNullable<DealDetalhadoBroker["assinatura"]>;
    assinatura = { estado: a.estado, total: a.total, assinadas: a.assinadas, recusadas: a.recusadas, pendentes: a.pendentes };
  }

  return {
    id: item.id,
    etapa: item.etapa,
    pendencias,
    atualizadoEm: item.atualizadoEm,
    referencia: item.referencia,
    partes,
    contrato,
    assinatura,
  };
}

/** Campos que a projeção do broker NUNCA pode conter. Ver o teste de paridade. */
export const CAMPOS_PROIBIDOS_AO_BROKER = [
  "titulo",
  "cliente",
  "valor",
  "clientName",
  "title",
  "value",
  "email",
  "telefone",
  "phone",
  "cpf",
  "cpfCnpj",
  "dataJson",
  // `nome` NÃO entra aqui de propósito: no `deal.detail` do broker o parser monta `partes` só com
  // `papel` e o item segue (detalhar-negocio.test.ts, "regressão do servidor"). Na lista, a mesma
  // resposta viraria falha para o corretor sem proteger nada a mais.
] as const;

export interface ScopeQueryResponse<T> {
  items: T[];
  truncated?: boolean;
}
