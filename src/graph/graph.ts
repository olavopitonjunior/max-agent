import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { identifyByPhone, fetchProfile, type Identity } from "@/lib/cm";
import type { InboundMessage } from "@/lib/zapi";

/**
 * Grafo de conversa do Max.
 *
 * A notificação PROATIVA não passa por aqui — ela é um caminho determinístico
 * (`/notify` → outbox → Z-API), sem modelo. Este grafo existe só para o
 * inbound: quando alguém responde ou pergunta.
 *
 * O que o LangGraph resolve e não vale reimplementar:
 *  - **checkpointer**: o histórico por thread persiste entre invocações, o que
 *    em serverless é obrigatório (não há processo vivo entre requests);
 *  - **`interrupt()`**: pausa o grafo esperando confirmação humana e retoma no
 *    turno seguinte, sem inventar máquina de estado — é como todo write no
 *    ImobPro vai ser confirmado (Fase 3);
 *  - **thread_id**: isolamento de memória por (org, telefone) de graça.
 */

export const MaxState = Annotation.Root({
  /** Mensagem que abriu o turn. */
  inbound: Annotation<InboundMessage>,
  /** Preenchido pelo `identify`; `null` = número desconhecido. */
  identity: Annotation<Identity | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Motivo de encerrar sem responder, quando houver. */
  halt: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Texto a enviar de volta. Vazio = não responde. */
  reply: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type MaxStateType = typeof MaxState.State;

/**
 * `thread_id = orgId:telefone`.
 *
 * O orgId no começo isola a memória por tenant por CONSTRUÇÃO: se o mesmo
 * número um dia pertencer a outra imobiliária, é outra thread, e nada do
 * contexto antigo vaza.
 */
export function threadIdFor(orgId: string, phone: string): string {
  return `${orgId}:${phone}`;
}

async function identify(state: MaxStateType): Promise<Partial<MaxStateType>> {
  const identity = await identifyByPhone(state.inbound.fromPhone);
  if (!identity) {
    return {
      identity: null,
      halt: "desconhecido",
      reply:
        "Oi! Sou o Max, assistente das imobiliárias parceiras. " +
        "Não reconheci este número — fale com seu corretor para liberar o acesso.",
    };
  }
  return { identity };
}

/**
 * Kill switch e teto: o perfil vem do console do ImobPro, então desligar o Max
 * lá tem efeito aqui sem redeploy.
 *
 * Falha de leitura NÃO derruba o turn: teto e persona são controle de custo e
 * de tom, não de segurança. Ficar mudo porque a API oscilou é o pior dos dois
 * erros.
 */
async function gate(state: MaxStateType): Promise<Partial<MaxStateType>> {
  const orgId = state.identity?.orgId;
  if (!orgId) return {};

  const profile = await fetchProfile(orgId).catch((err) => {
    console.warn("[graph] perfil indisponível, seguindo:", err?.message ?? err);
    return null;
  });

  if (profile && !profile.enabled) {
    return {
      halt: "desligado",
      reply:
        "No momento estou indisponível. Sua imobiliária foi avisada — " +
        "fale com seu corretor por enquanto.",
    };
  }
  return {};
}

/**
 * Placeholder da Fase 2 (RAG + LLM). Hoje o Max é canal de notificação, então
 * responder de forma previsível e honesta é melhor que responder mal — e deixa
 * o grafo inteiro exercitável ponta a ponta sem chave de modelo.
 */
async function respond(state: MaxStateType): Promise<Partial<MaxStateType>> {
  if (state.reply) return {};
  const first = state.identity?.userName?.split(/\s+/)[0];
  return {
    reply:
      `${first ? `Oi, ${first}! ` : "Oi! "}` +
      "Recebi sua mensagem. Ainda estou aprendendo a conversar — por enquanto " +
      "envio os avisos do seu processo. Em breve respondo dúvidas por aqui.",
  };
}

function afterIdentify(state: MaxStateType): "gate" | typeof END {
  return state.halt ? END : "gate";
}

function afterGate(state: MaxStateType): "respond" | typeof END {
  return state.halt ? END : "respond";
}

export function buildGraph() {
  return new StateGraph(MaxState)
    .addNode("identify", identify)
    .addNode("gate", gate)
    .addNode("respond", respond)
    .addEdge(START, "identify")
    .addConditionalEdges("identify", afterIdentify, { gate: "gate", [END]: END })
    .addConditionalEdges("gate", afterGate, { respond: "respond", [END]: END })
    .addEdge("respond", END);
}

let checkpointer: PostgresSaver | null = null;

/**
 * Um checkpointer por instância de function. `setup()` cria as tabelas do
 * LangGraph e é idempotente, mas roda uma vez só por processo — chamá-lo a cada
 * turn adicionaria round-trips ao caminho quente.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    checkpointer = PostgresSaver.fromConnString(url);
    await checkpointer.setup();
  }
  return checkpointer;
}

export async function runTurn(inbound: InboundMessage): Promise<string | null> {
  const app = buildGraph().compile({ checkpointer: await getCheckpointer() });

  // A thread só é conhecida DEPOIS do identify (é ele que descobre a org), mas
  // o checkpointer precisa dela antes. Usar o telefone como namespace
  // provisório mantém a conversa de um desconhecido coerente sem inventar org.
  const provisional = threadIdFor("unknown", inbound.fromPhone);
  const result = await app.invoke(
    { inbound },
    { configurable: { thread_id: provisional } }
  );

  return result.reply ?? null;
}
