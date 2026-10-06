import type { LlmToolCall } from "@/lib/llm";
import type { Candidate } from "@/lib/identity";
import { consultarEscopo, descartarSeVazou, subjectDe } from "@/lib/scope";
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
import { numerarLista, type MapaDeReferencias } from "./referencias";

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

    const r = await executarLeitura({
      entrada: a.entrada as EntradaDeLeitura,
      chamada,
      identity: params.identity,
      subject,
      fromPhone: params.fromPhone,
    });

    if (!r) {
      resultados.push({ tool: chamada.name, items: null, truncated: false });
      trilha.push({ name: chamada.name, args: chamada.args, outcome: "falha_na_consulta" });
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
      resultados.push({
        tool: chamada.name,
        items: numerada.paraOModelo,
        // Corte NOSSO (teto de 5) também se declara: lista cortada não pode
        // passar por completa.
        truncated: r.truncated || numerada.cortados > 0,
      });
    } else {
      resultados.push({ tool: chamada.name, items: r.items, truncated: r.truncated });
    }
    trilha.push({ name: chamada.name, args: chamada.args, outcome: "ok" });
  }

  return { resultados, trilha, referencias };
}

/** O executor de leitura: `scope-query` no servidor + a rede da regra 5. */
async function executarLeitura(params: {
  entrada: EntradaDeLeitura;
  chamada: LlmToolCall;
  identity: Candidate;
  subject: ReturnType<typeof subjectDe>;
  fromPhone: string;
}): Promise<{ items: unknown[]; truncated: boolean } | null> {
  const r = await consultarEscopo({
    orgId: params.identity.orgId,
    rawPhone: params.fromPhone,
    subject: params.subject,
    verb: params.entrada.verb,
    args: params.chamada.args,
  });
  if (!r) return null;
  // Rede de segurança da regra 5 — a projeção que VALE é a do servidor.
  return { items: descartarSeVazou(r.items, params.identity.kind), truncated: r.truncated };
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
