import type { LlmToolCall } from "@/lib/llm";
import type { Candidate } from "@/lib/identity";
import { consultarEscopo, descartarSeVazou, subjectDe } from "@/lib/scope";
import { lerPreferencias } from "@/lib/cm";
import {
  lerDealDetalhado,
  PERIODOS_DE_METRICA,
  QUEBRAS_DE_METRICA,
  type DealDetalhadoBroker,
  type DealDetalhadoUser,
} from "./scope-contract";
import { linkSeguro, texto } from "./notificacao-projecao";
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
import { projetarResumoDePendencias } from "./avisos-projecao";
import { atividadeEmHoraLocal } from "./atividade-hora-local";

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
      numeroDoDetalhe = selected.item.n;
      args = { atividade_id: selected.item.id };
    }
    // `pending.avisos` (2.8b): o bloco `avisos` só é PEDIDO por quem tem a capability E é usuário da
    // plataforma (corretor comissionado não tem fila). O CM só o devolve quando pedido pelo nome.
    const avisosLiberados = params.policy.includes("pending.avisos") && params.identity.kind === "user";
    if (entrada.verb === "pending.summary") {
      // Só passa o que o servidor entende: `filtro` (enum) vira `blocos` com um
      // bloco, `negocio_id` vira `dealId`. Qualquer outro campo do modelo some.
      let filtro = lerBlocoDePendencia(args.filtro);
      const dealId = typeof args.negocio_id === "string" ? args.negocio_id.trim().slice(0, 64) : "";
      // Filtro "avisos" sem a capability: resposta de "não disponível" e NENHUMA chamada ao CM.
      if (filtro === "avisos" && !avisosLiberados) {
        resultados.push({ tool: chamada.name, items: [{ avisos: { disponivel: false, total: 0, itens: [] } }], truncated: false });
        trilha.push({ name: chamada.name, args: chamada.args, outcome: "sem_permissao" });
        continue;
      }
      // Com `dealId` o servidor não devolve avisos (a fila é da pessoa, não do negócio): o negócio
      // manda, e o filtro "avisos" cai (vira a consulta de sempre, restrita ao negócio).
      if (filtro === "avisos" && dealId) filtro = null;
      // Sem filtro, o servidor decide os blocos sozinho e NÃO inclui `avisos` (só pedido por nome):
      // com a capability e sem negócio, a lista passa a ser explícita, com os quatro.
      const blocos = filtro ? [filtro] : avisosLiberados && !dealId ? [...BLOCOS_DE_PENDENCIA_SEM_FILTRO, "avisos"] : null;
      args = { ...(blocos ? { blocos } : {}), ...(dealId ? { dealId } : {}) };
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

    // Avisos da fila: whitelist de campos, dado de terceiro marcado; sem a capability o bloco sai do resumo.
    if (entrada.verb === "pending.summary" && !semPermissao) r.items = r.items.map((it) => projetarResumoDePendencias(it, avisosLiberados));

    // Notificação: só os campos que o Max conhece; título/corpo (CM do Passo 5) entram marcados como dado de terceiros.
    if (entrada.verb === "notification.list") r.items = r.items.map(projetarNotificacao);
    if (entrada.verb === "activity.list" || entrada.verb === "activity.get") r.items = r.items.map(atividadeEmHoraLocal);

    // `deal.detail` (PR-O4a): o item é LIDO como o contrato manda (chave a mais, a menos ou de tipo
    // errado descarta) e vira um resumo pronto em PT-BR. O modelo nunca vê o JSON do servidor, só o
    // texto que este módulo montou — e o que o render não escreve, ele não pode repetir.
    if (entrada.verb === "deal.detail") {
      const sujeito = params.identity.kind;
      const idPedido = args.negocio_id;
      const lidos = r.items.map((it) => lerDealDetalhado(it, sujeito));
      const validos = lidos.filter((d): d is NonNullable<typeof d> => d !== null && d.id === idPedido);
      // Item que não confere com o contrato (ou com o id pedido) NÃO vira "sem acesso": é falha, e alta.
      if (validos.length !== r.items.length) {
        console.error(`[despachante] deal.detail fora do contrato na org ${params.identity.orgId}: ${r.items.length - validos.length} item(ns) descartado(s)`);
        resultados.push({ tool: chamada.name, items: null, truncated: false });
        trilha.push({ name: chamada.name, args: chamada.args, outcome: "falha_na_consulta" });
        continue;
      }
      const resumo = validos.length > 0 ? renderDealDetalhado(validos[0], sujeito) : NEGOCIO_NAO_ENCONTRADO;
      resultados.push({
        tool: chamada.name,
        // `_untrusted`: o resumo carrega título, nome de cliente e de parte, digitados por terceiros.
        items: [validos.length > 0 ? { n: numeroDoDetalhe, _untrusted: true, resumo } : { n: numeroDoDetalhe, resumo }],
        truncated: false,
      });
      trilha.push({ name: chamada.name, args: chamada.args, outcome: "ok" });
      continue;
    }

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
    // Detalhe apontado por número não é lista: renumerar trocaria a numeração vigente por um item só,
    // e o próximo "cancela a 1" cairia em outra atividade.
    const produz = (a.entrada as EntradaDeLeitura).refs?.produz;
    if (produz && numeroDoDetalhe === null) {
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

/**
 * Vazio de `deal.detail`: o servidor responde `{items:[]}` igual para "sem a capability", "fora do
 * escopo", "outra org" e "não existe" (de propósito: não distingue). O Max também não distingue,
 * e não inventa negócio.
 */
export const NEGOCIO_NAO_ENCONTRADO = "Não encontrei esse negócio, ou você não tem acesso a ele.";

const FUSO_DO_NEGOCIO = "America/Sao_Paulo";

/** "2026-10-20T12:00:00.000Z" -> "20/10/2026" (horário de Brasília); inválida -> null. */
function dataLocal(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("pt-BR", { timeZone: FUSO_DO_NEGOCIO, day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Texto de terceiro dentro de uma linha de WhatsApp: sem controle/bidi/quebra (`texto`) e sem `*`,
 * que fecharia ou forjaria um negrito. Vazio vira `null` (a linha some).
 */
function limpo(v: string | null): string | null {
  const t = texto(v);
  const sem = t ? t.replace(/\*+/g, "").replace(/\s+/g, " ").trim() : "";
  return sem || null;
}

const ESTADO_DO_CONTRATO: Record<string, string> = {
  rascunho: "em rascunho",
  aprovado: "aprovado",
  assinado: "assinado",
  revogado: "revogado",
};
const ESTADO_DO_ENVELOPE: Record<string, string> = {
  running: "em andamento",
  closed: "concluída",
  canceled: "cancelada",
  failed: "com falha",
};
/** Estado conhecido vira PT-BR; desconhecido sai como veio (limpo), nunca inventado. */
function rotulo(mapa: Record<string, string>, estado: string): string | null {
  return mapa[estado] ?? limpo(estado.replace(/_/g, " ").toLowerCase());
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** "1 de 3 assinadas, 1 recusada, 1 pendente": zero some, singular/plural certo. */
function contagemDeAssinaturas(a: { total: number; assinadas: number; recusadas: number; pendentes: number }): string {
  const partes = [`${a.assinadas} de ${a.total} assinadas`];
  if (a.recusadas > 0) partes.push(plural(a.recusadas, "recusada", "recusadas"));
  if (a.pendentes > 0) partes.push(plural(a.pendentes, "pendente", "pendentes"));
  return partes.join(", ");
}

const MAX_PENDENCIAS_NO_RESUMO = 10;

/**
 * O resumo de UM negócio, pronto para a conversa: PT-BR, formato WhatsApp (`*negrito*`, nunca
 * `**`), sem id interno e sem `n=`.
 *
 * **Só escreve o que veio.** Campo `null` (ou lista vazia) não vira frase: a linha some. O que o
 * corretor comissionado não recebe do servidor este render não tem de onde tirar (a forma dele é
 * outra), e o teste afirma a AUSÊNCIA de título, cliente, valor, nome, link e proposta no texto.
 * Recebe o item já LIDO por `lerDealDetalhado`, nunca o JSON cru.
 */
export function renderDealDetalhado(item: DealDetalhadoUser, sujeito: "user"): string;
export function renderDealDetalhado(item: DealDetalhadoBroker, sujeito: "broker"): string;
export function renderDealDetalhado(item: DealDetalhadoUser | DealDetalhadoBroker, sujeito: "user" | "broker"): string;
export function renderDealDetalhado(item: DealDetalhadoUser | DealDetalhadoBroker, sujeito: "user" | "broker"): string {
  const linhas: string[] = [];
  const user = sujeito === "user" ? (item as DealDetalhadoUser) : null;
  const broker = sujeito === "broker" ? (item as DealDetalhadoBroker) : null;

  const titulo = limpo(user ? user.titulo : (broker as DealDetalhadoBroker).referencia);
  if (titulo) linhas.push(user ? `*${titulo}* (${user.tipo === "locacao" ? "locação" : "venda"})` : `*${titulo}*`);

  const etapa = limpo(item.etapa);
  if (etapa) linhas.push(`Etapa: ${etapa}`);

  if (user) {
    const cliente = limpo(user.cliente);
    if (cliente) linhas.push(`Cliente: ${cliente}`);
    if (user.valor !== null) {
      linhas.push(`Valor: ${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(user.valor).replace(/ /g, " ")}`);
    }
    const partes = user.partes.map((p) => [limpo(p.papel), limpo(p.nome)].filter(Boolean).join(" ")).filter(Boolean);
    if (partes.length > 0) linhas.push(`Partes: ${partes.join("; ")}`);

    if (user.contrato) {
      const estado = rotulo(ESTADO_DO_CONTRATO, user.contrato.estado);
      const em = dataLocal(user.contrato.atualizadoEm);
      if (estado) linhas.push(`Contrato: ${estado}, versão ${user.contrato.versao}${em ? ` (atualizado em ${em})` : ""}`);
    }
    if (user.proposta) {
      const estado = rotulo({}, user.proposta.estado);
      const codigo = limpo(user.proposta.codigo) ?? "sem código";
      linhas.push(`Proposta: ${codigo}${estado ? ` (${estado})` : ""}`);
    }
  } else {
    const b = broker as DealDetalhadoBroker;
    const papeis = b.partes.map((p) => limpo(p.papel)).filter(Boolean);
    if (papeis.length > 0) linhas.push(`Partes: ${papeis.join(", ")}`);
    if (b.contrato) {
      const estado = rotulo(ESTADO_DO_CONTRATO, b.contrato.estado);
      if (estado) linhas.push(`Contrato: ${estado}`);
    }
  }

  const assinatura = item.assinatura;
  if (assinatura) {
    linhas.push(`Assinaturas: ${contagemDeAssinaturas(assinatura)}`);
    const situacao = rotulo(ESTADO_DO_ENVELOPE, assinatura.estado);
    if (situacao) {
      let fim = "";
      if (user?.assinatura) {
        const concluida = assinatura.estado === "closed" ? dataLocal(user.assinatura.concluidoEm) : null;
        const enviada = dataLocal(user.assinatura.enviadoEm);
        fim = concluida ? ` em ${concluida}` : enviada ? ` (enviada em ${enviada})` : "";
      }
      linhas.push(`Situação da assinatura: ${situacao}${fim}`);
    }
  }

  const pendencias = item.pendencias.map((p) => limpo(p)).filter((p): p is string => !!p);
  if (pendencias.length === 0) {
    linhas.push("Pendências: nenhuma");
  } else {
    const mostradas = pendencias.slice(0, MAX_PENDENCIAS_NO_RESUMO);
    const resto = pendencias.length - mostradas.length;
    linhas.push(`Pendências: ${mostradas.join("; ")}${resto > 0 ? `; e mais ${resto}` : ""}`);
  }

  const atualizado = dataLocal(item.atualizadoEm);
  if (atualizado) linhas.push(`Atualizado em ${atualizado}`);

  if (user) {
    const link = linkSeguro(user.link);
    if (link) linhas.push(`Link: ${link}`);
  }
  return linhas.join("\n");
}

/** Os blocos que o servidor devolve em `pending.summary` quando nenhum é pedido (sem `avisos`). */
export const BLOCOS_DE_PENDENCIA_SEM_FILTRO = ["formularios", "propostas", "atividades"] as const;

/** Blocos que o servidor aceita em `pending.summary`. Valor fora da lista some (todos os blocos). */
export function lerBlocoDePendencia(v: unknown): "formularios" | "propostas" | "atividades" | "avisos" | null {
  return v === "formularios" || v === "propostas" || v === "atividades" || v === "avisos" ? v : null;
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
