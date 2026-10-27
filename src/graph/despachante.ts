import type { LlmToolCall } from "@/lib/llm";
import type { Candidate } from "@/lib/identity";
import { consultarEscopo, descartarSeVazou, subjectDe } from "@/lib/scope";
import { lerPreferencias } from "@/lib/cm";
import { PERIODOS_DE_METRICA, QUEBRAS_DE_METRICA } from "./scope-contract";
import type { ToolLogEntry } from "@/lib/turnlog";
import type { Capability } from "./policy";
import {
  buscarNoRegistro,
  capabilityDaCriacao,
  lerFinalidade,
  lerNatureza,
  lerTipo,
  podeEscrever,
  type EntradaDeLeitura,
  type EntradaDeTool,
  type PendingAction,
} from "./tools";
import { ITENS_POR_LISTA, REFERENCIA_TTL_MS, resolverReferencia, numerarLista, type MapaDeReferencias } from "./referencias";
import type { StageClarification } from "./query-options";
import { projetarParaOModelo } from "./preferencias";
import { projetarNotificacao } from "./notificacao-projecao";

/**
 * O DESPACHANTE — a única porta por onde uma chamada de tool vira efeito.
 *
 * ── Por que um só ─────────────────────────────────────────────────────────
 *
 * O modelo pode emitir uma chamada com o nome de qualquer tool, oferecida ou
 * não: por alucinação, ou porque uma instrução injetada num resultado anterior
 * mandou. Cada nó que executasse por conta própria teria a sua lista de
 * checagens — e a que esquecesse uma seria a porta. Aqui as quatro travas são
 * as mesmas para leitura e escrita, na mesma ordem:
 *
 *  (a) a tool EXISTE no registro;
 *  (b) foi OFERECIDA neste turn (o que o modelo viu, não o catálogo inteiro);
 *  (c) a política resolvida CONCEDE a capability desta chamada (G4);
 *  (d) para escrita, a identidade PODE escrever (corretor sem login, nunca).
 *
 * Só depois disso o executor da entrada roda. A permissão do servidor (G1) é
 * a quinta trava e mora no ImobPro — esta não a substitui, só a antecede.
 */

export type Recusa =
  | "tool_desconhecida"
  | "nao_oferecida"
  | "capability_negada"
  | "identidade_nao_escreve"
  /** Nome histórico na trilha: argumento fora do enum da `propor_criacao`. */
  | "tipo_invalido";

export type Autorizacao =
  | { ok: true; entrada: EntradaDeTool; capability: Capability }
  | { ok: false; motivo: Recusa; entrada?: EntradaDeTool };

/**
 * As quatro travas, sem efeito colateral. Puro de propósito: é o que os
 * testes de recusa exercitam sem grafo, sem rede e sem modelo.
 */
export function autorizarChamada(params: {
  chamada: Pick<LlmToolCall, "name" | "args">;
  oferecidas: readonly string[];
  policy: readonly Capability[];
  identity: Candidate;
}): Autorizacao {
  const entrada = buscarNoRegistro(params.chamada.name);
  if (!entrada) return { ok: false, motivo: "tool_desconhecida" };

  if (!params.oferecidas.includes(entrada.nome)) {
    return { ok: false, motivo: "nao_oferecida", entrada };
  }

  // (d) antes de (c) na escrita: "quem não pode escrever" é a recusa mais
  // estável — não depende de política nem de argumento.
  if (entrada.tipo === "escrita" && !podeEscrever(params.identity)) {
    return { ok: false, motivo: "identidade_nao_escreve", entrada };
  }

  const capability =
    entrada.tipo === "leitura"
      ? entrada.capability
      : entrada.capabilityDaChamada(params.chamada.args ?? {});
  if (!capability) return { ok: false, motivo: "tipo_invalido", entrada };

  if (!params.policy.includes(capability)) {
    return { ok: false, motivo: "capability_negada", entrada };
  }

  return { ok: true, entrada, capability };
}

// ─── Executor de LEITURA ──────────────────────────────────────────────────

/**
 * O que uma tool de leitura devolveu, pronto para a cerca do prompt.
 *
 * `items: null` é FALHA explícita, e não lista vazia: "não consegui consultar"
 * e "você não tem negócio" são respostas diferentes, e apresentar a primeira
 * como a segunda mentiria para a pessoa sobre a carteira dela.
 */
export interface ResultadoDeTool {
  tool: string;
  items: unknown[] | null;
  truncated: boolean;
  hasMore?: boolean;
  clarification?: StageClarification;
  /** `template.decisions`: modelos não medidos (o modelo nunca diz "sem pendência" com isso > 0). */
  naoMedidos?: number;
}

/**
 * Despacha as leituras de uma volta do laço.
 *
 * ⚠️ Nunca devolve `toolLog`/`usage` vazios para o grafo espalhar — quem
 * chama espalha condicionalmente (ver o cabeçalho do nó `tools`).
 */
export async function despacharLeituras(params: {
  chamadas: LlmToolCall[];
  oferecidas: readonly string[];
  policy: readonly Capability[];
  identity: Candidate;
  fromPhone: string;
  referencias: MapaDeReferencias | null;
  turno: string;
  agora?: number;
}): Promise<{
  resultados: ResultadoDeTool[];
  trilha: ToolLogEntry[];
  referencias: MapaDeReferencias | null;
}> {
  const subject = subjectDe(params.identity);
  const resultados: ResultadoDeTool[] = [];
  const trilha: ToolLogEntry[] = [];
  let referencias = params.referencias;

  for (const chamada of params.chamadas) {
    const a = autorizarChamada({
      chamada,
      oferecidas: params.oferecidas,
      policy: params.policy,
      identity: params.identity,
    });

    // Escrita que chegou ao laço de leitura não executa aqui: o caminho dela
    // é a pendência + confirmação, no `answer`/`confirm`.
    if (a.ok && a.entrada.tipo !== "leitura") {
      trilha.push({ name: chamada.name, args: chamada.args, outcome: "nao_oferecida" });
      resultados.push({ tool: chamada.name, items: null, truncated: false });
      continue;
    }

    if (!a.ok) {
      // Recusada E registrada: chamada descartada vale tanto quanto a aceita
      // para quem depura. E volta como FALHA ao modelo em vez de sumir —
      // queimar uma volta em silêncio quebraria o "sempre sinalize".
      if (a.motivo === "capability_negada") {
        console.warn(
          `[despachante] ${chamada.name} chamada SEM a capability na org ${params.identity.orgId}`
        );
      }
      trilha.push({ name: chamada.name, args: chamada.args, outcome: a.motivo });
      resultados.push({ tool: chamada.name, items: null, truncated: false });
      continue;
    }

    const entrada = a.entrada as EntradaDeLeitura;
    let args = { ...chamada.args };
    const agora = params.agora ?? Date.now();
    const subjectKey = JSON.stringify([params.identity.orgId, subject]);
    const paginada = ["property.list", "activity.list", "notification.list"].includes(entrada.verb);
    if (entrada.verb === "property.detail" || entrada.verb === "contract.status") {
      const property = entrada.verb === "property.detail";
      const selected = resolverReferencia(referencias, args.numero, { agora, tipo: property ? "imovel" : "negocio" });
      if (!selected.ok) {
        resultados.push({ tool: chamada.name, items: null, truncated: false });
        trilha.push({ name: chamada.name, args: chamada.args, outcome: "referencia_invalida" });
        continue;
      }
      args = { [property ? "imovel_id" : "negocio_id"]: selected.item.id };
    }
    // Detalhe de proposta/negócio: o modelo aponta pelo número da lista; o id nunca passa por ele
    // e não há "a mais recente" por omissão (sem número válido, recusa).
    let numeroDoDetalhe: number | null = null;
    if (entrada.verb === "proposal.detail" || entrada.verb === "deal.detail") {
      const proposta = entrada.verb === "proposal.detail";
      const selected = resolverReferencia(referencias, args.numero, { agora, tipo: proposta ? "proposta" : "negocio" });
      if (!selected.ok) {
        resultados.push({ tool: chamada.name, items: null, truncated: false });
        trilha.push({ name: chamada.name, args: chamada.args, outcome: "referencia_invalida" });
        continue;
      }
      numeroDoDetalhe = selected.item.n;
      args = { [proposta ? "proposta_id" : "negocio_id"]: selected.item.id };
    }
    // Sem argumento nenhum: o servidor responde pela org da sessão, o modelo não escolhe nada.
    if (entrada.verb === "template.decisions") args = {};
    if (entrada.verb === "activity.get") {
      // O modelo aponta pelo número da lista; o id interno nunca passa por ele.
      const selected = resolverReferencia(referencias, args.numero, { agora, tipo: "atividade" });
      if (!selected.ok) {
        resultados.push({ tool: chamada.name, items: null, truncated: false });
        trilha.push({ name: chamada.name, args: chamada.args, outcome: "referencia_invalida" });
        continue;
      }
      args = { atividade_id: selected.item.id };
    }
    if (entrada.verb === "pending.summary") {
      // Só passa o que o servidor entende: `filtro` (enum) vira `blocos` com um
      // bloco, `negocio_id` vira `dealId`. Qualquer outro campo do modelo some.
      const filtro = lerBlocoDePendencia(args.filtro);
      const dealId = typeof args.negocio_id === "string" ? args.negocio_id.trim().slice(0, 64) : "";
      args = { ...(filtro ? { blocos: [filtro] } : {}), ...(dealId ? { dealId } : {}) };
    }
    if (entrada.verb === "metrics.get") {
      // Só `periodo` e `quebra`, ambos dentro do enum: `estado`, `numero`, `mais` e o resto do modelo somem.
      args = lerArgsDeMetrica(args);
    }
    if (paginada) {
      const continuation = referencias?.continuacao;
      if (args.mais === true) {
        if (!continuation || continuation.tool !== chamada.name || continuation.subjectKey !== subjectKey || agora - continuation.criadoEm > REFERENCIA_TTL_MS) {
          resultados.push({ tool: chamada.name, items: null, truncated: false, hasMore: false });
          trilha.push({ name: chamada.name, args: chamada.args, outcome: "continuacao_invalida" });
          continue;
        }
        args = { ...continuation.args, cursor: continuation.cursor };
      } else {
        // Model-provided cursors and identifiers never select a page.
        const filtro = entrada.verb === "activity.list" && lerFiltroDeAtividade(args.filtro);
        args = {
          ...(typeof args.estado === "string" ? { estado: args.estado } : {}),
          ...(filtro ? { filtro } : {}),
        };
      }
      args.limite = ITENS_POR_LISTA;
    }
    const lido = await executarLeitura({
      entrada: a.entrada as EntradaDeLeitura,
      chamada: { ...chamada, args },
      identity: params.identity,
      subject,
      fromPhone: params.fromPhone,
    });
    // Formato fixado com a plataforma: COM permissão, `items: [PendenciasDoUsuario]`
    // (totais 0 quando não há nada pendente); SEM permissão, `[]` ou `[null]`.
    // O "sem permissão" não pode virar lista vazia (o modelo diria "nada
    // pendente") nem falha (ofereceria tentar de novo).
    const semPermissao = !!lido && entrada.verb === "pending.summary" && !ehResumoDePendencias(lido.items[0]);
    const r = semPermissao && lido ? { ...lido, items: [{ sem_permissao: true }] } : lido;

    if (!r) {
      resultados.push({ tool: chamada.name, items: null, truncated: false });
      trilha.push({ name: chamada.name, args: chamada.args, outcome: "falha_na_consulta" });
      continue;
    }

    // Notificação: só os campos que o Max conhece; título/corpo (CM do Passo 5) entram marcados como dado de terceiros.
    if (entrada.verb === "notification.list") r.items = r.items.map(projetarNotificacao);

    // Negado no servidor volta `{items:[]}` SEM `naoMedidos`; vazio de verdade sempre o traz.
    // Sem ele, o modelo diria "não há pendência" a quem só não tem acesso.
    if (entrada.verb === "template.decisions" && r.naoMedidos === undefined) {
      resultados.push({ tool: chamada.name, items: null, truncated: false });
      trilha.push({ name: chamada.name, args: chamada.args, outcome: "falha_na_consulta" });
      continue;
    }

    if (r.clarification) {
      resultados.push({ tool: chamada.name, items: null, truncated: false, clarification: r.clarification });
      trilha.push({ name: chamada.name, args: chamada.args, outcome: chamada.args.opcoes_etapas === true ? "opcoes_consulta" : "filtro_invalido" });
      continue;
    }

    // G2: o código numera, o modelo vê só número + rótulo. Leitura que não
    // declara o que produz passa como veio (nenhuma hoje).
    const produz = (a.entrada as EntradaDeLeitura).refs?.produz;
    if (produz) {
      const numerada = numerarLista({
        items: r.items,
        tipo: produz,
        anterior: referencias,
        turno: params.turno,
        agora: params.agora ?? Date.now(),
      });
      referencias = numerada.mapa;
      if (paginada && r.nextCursor) {
        const { cursor: _cursor, ...filters } = args;
        referencias.continuacao = { tool: chamada.name, cursor: r.nextCursor, args: filters, subjectKey, criadoEm: agora };
      }
      resultados.push({
        tool: chamada.name,
        items: numerada.paraOModelo,
        // Corte NOSSO (teto de 5) também se declara: lista cortada não pode
        // passar por completa.
        truncated: r.truncated || numerada.cortados > 0,
        ...(paginada ? { hasMore: !!r.nextCursor } : {}),
      });
    } else if (numeroDoDetalhe !== null) {
      // Detalhe: o `id` do servidor fica fora do prompt; o modelo vê o MESMO número que a pessoa usou.
      const semId = r.items.map((it) => {
        if (!it || typeof it !== "object") return it;
        const { id: _id, ...resto } = it as Record<string, unknown>;
        return { n: numeroDoDetalhe, ...resto };
      });
      resultados.push({ tool: chamada.name, items: semId, truncated: r.truncated });
    } else {
      resultados.push({ tool: chamada.name, items: r.items, truncated: r.truncated, ...(r.naoMedidos !== undefined ? { naoMedidos: r.naoMedidos } : {}) });
    }
    trilha.push({ name: chamada.name, args: chamada.args, outcome: semPermissao ? "sem_permissao" : "ok" });
  }

  return { resultados, trilha, referencias };
}

/** Blocos que o servidor aceita em `pending.summary`. Valor fora da lista some (todos os blocos). */
export function lerBlocoDePendencia(v: unknown): "formularios" | "propostas" | "atividades" | null {
  return v === "formularios" || v === "propostas" || v === "atividades" ? v : null;
}

/**
 * Os argumentos que o servidor entende em `metrics.get`: `periodo` e `quebra`, cada um dentro do
 * seu enum. Valor fora da lista (ou outra chave) some; sem nada válido, `{}` (totais de agora).
 */
export function lerArgsDeMetrica(args: Record<string, unknown> | undefined): { periodo?: (typeof PERIODOS_DE_METRICA)[number]; quebra?: (typeof QUEBRAS_DE_METRICA)[number] } {
  const periodo = PERIODOS_DE_METRICA.find((p) => p === args?.periodo);
  const quebra = QUEBRAS_DE_METRICA.find((q) => q === args?.quebra);
  return { ...(periodo ? { periodo } : {}), ...(quebra ? { quebra } : {}) };
}

/** O item de `pending.summary` é o resumo (objeto), e não o `null` de "sem permissão". */
function ehResumoDePendencias(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Recortes que o servidor aceita em `activity.list`. Valor fora da lista some (sem filtro). */
export function lerFiltroDeAtividade(v: unknown): "minhas" | "atrasadas" | "hoje" | null {
  return v === "minhas" || v === "atrasadas" || v === "hoje" ? v : null;
}

/** O executor de leitura: `scope-query` no servidor + a rede da regra 5. */
async function executarLeitura(params: {
  entrada: EntradaDeLeitura;
  chamada: LlmToolCall;
  identity: Candidate;
  subject: ReturnType<typeof subjectDe>;
  fromPhone: string;
}): Promise<{ items: unknown[]; truncated: boolean; nextCursor?: string; clarification?: StageClarification; naoMedidos?: number } | null> {
  // Preferências de aviso (M3): rota própria, sempre da PRÓPRIA pessoa (telefone do turn). Só usuário
  // da plataforma tem preferência; qualquer outra identidade volta como "sem permissão", nunca como lista vazia.
  if (params.entrada.verb === "prefs.get") {
    if (params.identity.kind !== "user") return { items: [{ sem_permissao: true }], truncated: false };
    const view = await lerPreferencias({ orgId: params.identity.orgId, rawPhone: params.fromPhone });
    return view ? { items: [projetarParaOModelo(view)], truncated: false } : null;
  }
  const r = await consultarEscopo({
    orgId: params.identity.orgId,
    rawPhone: params.fromPhone,
    subject: params.subject,
    verb: params.entrada.verb,
    args: params.chamada.args,
  });
  if (!r) return null;
  // Rede de segurança da regra 5 — a projeção que VALE é a do servidor.
  return { items: descartarSeVazou(r.items, params.identity.kind), truncated: r.truncated, nextCursor: r.nextCursor, ...(r.clarification ? { clarification: r.clarification } : {}), ...(r.naoMedidos !== undefined ? { naoMedidos: r.naoMedidos } : {}) };
}

// ─── Executor de ESCRITA (proposta, nunca execução) ───────────────────────

/**
 * A `propor_criacao` autorizada vira os argumentos da pendência.
 *
 * Não executa: a entrada declara `confirmacao: true`, e o que este executor
 * produz é o que a pessoa vai CONFIRMAR. Nome do cliente cortado em 80 e
 * argumentos fora do enum descartados — valor estranho não vira locação.
 */
export function argsDaCriacao(
  args: Record<string, unknown>,
  /** Quem está falando com o Max. O cliente nunca é ele. */
  falante?: string | null
): PendingAction["args"] | null {
  const tipo = lerTipo(args.tipo);
  if (!tipo) return null;
  const bruto = args.nome_cliente;
  const nome =
    typeof bruto === "string" && bruto.trim() ? bruto.trim().slice(0, 80) : undefined;
  // Medido em 2026-10-06 (eval-conversa-criacao): o nano punha o nome de QUEM
  // FALA como cliente ("Olavo") mesmo com "compradora Letícia" na mensagem — o
  // nome da pessoa está no prompt e é o mais à mão. Nome que coincide com o do
  // falante some: proposta sem nome é recuperável na tela; com o nome do
  // corretor no lugar do comprador, não é percebida.
  const nomeCliente = nome && !mesmaPessoa(nome, falante) ? nome : undefined;
  return {
    tipo,
    nomeCliente,
    natureza: lerNatureza(args.natureza),
    finalidade: lerFinalidade(args.finalidade),
  };
}

/**
 * O nome dado é o do FALANTE? Todo token do nome precisa estar no nome dele:
 * "Olavo" e "Olavo Piton" caem contra "Olavo Piton"; "Maria Souza" contra
 * "Maria Silva" passa — xará é cliente legítimo (code review do #55).
 */
function mesmaPessoa(nome: string, falante?: string | null): boolean {
  if (!falante) return false;
  const tokens = (t: string) =>
    t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const doFalante = new Set(tokens(falante));
  const doNome = tokens(nome);
  return doNome.length > 0 && doNome.every((t) => doFalante.has(t));
}

/**
 * A pendência AINDA pode executar? Reconferida no turn do "sim".
 *
 * A política é resolvida por turn no `gate`; entre "posso criar?" e "sim" ela
 * pode ter mudado (papel rebaixado, org que tirou `form.create`, perfil fora
 * do ar). Executar com a autorização do turn anterior seria a política de
 * ontem decidindo a escrita de hoje. A trava (b) não se aplica aqui: a oferta
 * foi no turn da proposta, e é a pendência — não o modelo — que pede.
 */
export function autorizarPendencia(params: {
  pending: PendingAction;
  policy: readonly Capability[];
  identity: Candidate;
}): { ok: true } | { ok: false; motivo: Recusa } {
  if (!podeEscrever(params.identity)) return { ok: false, motivo: "identidade_nao_escreve" };
  const cap = capabilityDaCriacao(params.pending.args.tipo);
  if (!cap) return { ok: false, motivo: "tipo_invalido" };
  if (!params.policy.includes(cap)) return { ok: false, motivo: "capability_negada" };
  return { ok: true };
}
