import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  fetchProfile,
  searchKnowledge,
  reportUsage,
  type KnowledgeHit,
} from "@/lib/cm";
import {
  resolveIdentity,
  matchChoice,
  saveChoice,
  askWhichOrg,
  displayName,
  type Candidate,
} from "@/lib/identity";
import { complete, DEFAULT_MODEL, type LlmUsage } from "@/lib/llm";
import { buildSystemPrompt, shouldSearch } from "./prompt";
import type { InboundMessage } from "@/lib/zapi";

/**
 * Grafo de conversa do Max.
 *
 * A notificação PROATIVA não passa por aqui — é caminho determinístico
 * (`/notify` → outbox → Z-API), sem modelo. Este grafo é só para o inbound.
 *
 * O que o LangGraph resolve e não vale reimplementar:
 *  - **checkpointer**: o histórico por thread persiste entre invocações, o que
 *    em serverless é obrigatório (não há processo vivo entre requests);
 *  - **thread_id**: isolamento de memória por (org, telefone) de graça;
 *  - **`interrupt()`**: pausa esperando confirmação humana e retoma no turno
 *    seguinte — é como os writes vão ser confirmados na Fase 3.
 */

/** Quantos turnos vão no prompt. */
const MAX_HISTORY = 20;
/** Acima disto, os antigos viram resumo e saem do histórico. */
const COMPACT_AT = 16;
/** Quantos ficam depois da compactação. */
const KEEP_AFTER_COMPACT = 6;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Atualização do canal `messages`: normalmente uma lista a CONCATENAR, mas a
 * compactação precisa SUBSTITUIR.
 *
 * Sem essa distinção não há como encolher o histórico: com um reducer que só
 * concatena, devolver a lista podada a acrescentaria de novo — o oposto do
 * pretendido. E `updateState` por fora não ajuda, porque também passa pelo
 * reducer.
 */
type MessagesUpdate = ChatMessage[] | { replace: ChatMessage[] };

export const MaxState = Annotation.Root({
  inbound: Annotation<InboundMessage>,
  /** Resolvida ANTES do grafo — é ela que determina o `thread_id`. */
  identity: Annotation<Candidate>,

  messages: Annotation<ChatMessage[], MessagesUpdate>({
    reducer: (prev, next) =>
      Array.isArray(next) ? [...prev, ...next] : next.replace,
    default: () => [],
  }),

  /** Turnos antigos condensados. */
  summary: Annotation<string | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
  }),

  /** Instruções do tenant, lidas uma vez por turn no `gate`. */
  instructions: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  hits: Annotation<KnowledgeHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  reply: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  halt: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  model: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => DEFAULT_MODEL,
  }),
});

export type MaxStateType = typeof MaxState.State;
/**
 * O que um nó DEVOLVE, que não é o mesmo que o estado guarda: `messages` aceita
 * a forma `{ replace }` na atualização e é sempre uma lista no valor.
 */
export type MaxUpdate = typeof MaxState.Update;

/**
 * `thread_id = orgId:telefone`.
 *
 * O orgId primeiro isola a memória por tenant por CONSTRUÇÃO: se o mesmo número
 * um dia pertencer a outra imobiliária, é outra thread e nada do contexto
 * antigo vaza.
 */
export function threadIdFor(orgId: string, phone: string): string {
  return `${orgId}:${phone}`;
}

/**
 * Kill switch, modelo e persona — do console do ImobPro, então desligar o Max
 * lá tem efeito aqui sem redeploy.
 *
 * Falha de LEITURA não derruba o turn: persona e modelo são controle de tom e
 * de custo, não de segurança, e ficar mudo porque a API oscilou é o pior dos
 * dois erros. Já `enabled: false` é resposta afirmativa e vale.
 *
 * Lê o perfil UMA vez por turn e guarda no estado — os nós seguintes não
 * reconsultam.
 */
async function gate(state: MaxStateType): Promise<MaxUpdate> {
  const profile = await fetchProfile(state.identity.orgId).catch((err) => {
    console.warn("[graph] perfil indisponível, seguindo:", err?.message ?? err);
    return null;
  });

  if (profile && !profile.enabled) {
    return {
      halt: "desligado",
      reply:
        "No momento estou indisponível. Fale com seu corretor por enquanto — " +
        "sua imobiliária já foi avisada.",
    };
  }

  // `profile.model` é IGNORADO de propósito: aquele campo carrega id de modelo
  // Anthropic e este runtime fala com o OpenRouter. O registry do ImobPro já
  // declara `supports.model: false` pro Max — a tela não oferece o controle
  // justamente porque ele não valeria nada aqui.
  return { instructions: profile?.instructions?.composed ?? null };
}

async function retrieve(state: MaxStateType): Promise<MaxUpdate> {
  const text = state.inbound.text ?? "";
  if (!shouldSearch(text)) return { hits: [] };

  const hits = await searchKnowledge(state.identity.orgId, text).catch((err) => {
    // Base fora do ar não pode virar silêncio: sem material o prompt já manda
    // dizer "não sei", que é a resposta correta nesse estado.
    console.warn("[graph] RAG falhou:", err?.message ?? err);
    return [] as KnowledgeHit[];
  });
  return { hits };
}

async function answer(state: MaxStateType): Promise<MaxUpdate> {
  const system = buildSystemPrompt({
    tenantInstructions: state.instructions,
    orgName: state.identity.orgName,
    userName: displayName(state.identity),
    hits: state.hits,
    summary: state.summary,
  });

  const userText = state.inbound.text?.trim() || "(mensagem sem texto)";
  const history = state.messages.slice(-MAX_HISTORY);

  let result;
  try {
    result = await complete({
      system,
      messages: [...history, { role: "user", content: userText }],
      model: state.model,
    });
  } catch (err) {
    // O turn que falhou também custou: sem registrar a tentativa, um agente que
    // só erra aparece no painel como um agente que não gasta nada.
    const usage = (err as { usage?: LlmUsage }).usage;
    if (usage) void reportUsage(state.identity.orgId, usage);
    console.error("[graph] modelo falhou:", err instanceof Error ? err.message : err);
    return {
      messages: [{ role: "user", content: userText }],
      reply:
        "Tive um problema pra responder agora. Tenta de novo em instantes, " +
        "ou fala com seu corretor se for urgente.",
    };
  }

  // Fire-and-forget: perder a contabilidade de um turn é ruim; não responder
  // ao usuário por causa dela é pior.
  void reportUsage(state.identity.orgId, result.usage);

  return {
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: result.text },
    ],
    reply: result.text,
  };
}

/**
 * Condensa os turnos antigos e devolve o histórico ao tamanho de trabalho.
 *
 * Roda DEPOIS de responder, então não entra na latência que o usuário sente. É
 * a alternativa deliberada ao LangMem, cuja extração síncrona no turn tem p95
 * alto: aqui o custo fica fora do caminho crítico.
 */
async function compact(state: MaxStateType): Promise<MaxUpdate> {
  if (state.messages.length < COMPACT_AT) return {};

  const keep = state.messages.slice(-KEEP_AFTER_COMPACT);
  const older = state.messages.slice(0, -KEEP_AFTER_COMPACT);
  const transcript = older
    .map((m) => `${m.role === "user" ? "Cliente" : "Max"}: ${m.content}`)
    .join("\n")
    .slice(0, 8000);

  try {
    const result = await complete({
      system:
        "Resuma a conversa abaixo em no máximo 5 linhas, em português, " +
        "preservando o que foi PEDIDO, o que foi RESPONDIDO e o que ficou " +
        "pendente. Não invente nada que não esteja no texto.",
      messages: [
        {
          role: "user",
          content: `${state.summary ? `Resumo anterior:\n${state.summary}\n\n` : ""}${transcript}`,
        },
      ],
      // Mesmo modelo do turn: o nano já é o barato da casa, e trocar de
      // modelo só pra resumir acrescentaria uma segunda tabela de preço a
      // manter sem economizar nada.
      maxTokens: 400,
    });

    void reportUsage(state.identity.orgId, result.usage);
    return { summary: result.text, messages: { replace: keep } };
  } catch (err) {
    // Falhar aqui só significa contexto mais longo no próximo turn — nunca
    // vale descartar histórico sem ter conseguido resumi-lo.
    console.warn(
      "[graph] compactação falhou, histórico mantido:",
      err instanceof Error ? err.message : err
    );
    return {};
  }
}

function afterGate(state: MaxStateType): "retrieve" | typeof END {
  return state.halt ? END : "retrieve";
}

export function buildGraph() {
  return new StateGraph(MaxState)
    .addNode("gate", gate)
    .addNode("retrieve", retrieve)
    .addNode("answer", answer)
    .addNode("compact", compact)
    .addEdge(START, "gate")
    .addConditionalEdges("gate", afterGate, { retrieve: "retrieve", [END]: END })
    .addEdge("retrieve", "answer")
    .addEdge("answer", "compact")
    .addEdge("compact", END);
}

let checkpointer: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não configurada");
    checkpointer = PostgresSaver.fromConnString(url);
    await checkpointer.setup();
  }
  return checkpointer;
}

/**
 * Um turn completo.
 *
 * A identidade é resolvida ANTES do grafo, e não num nó: o `thread_id` precisa
 * ser conhecido no `invoke`, e ele depende da org. Resolver dentro faria a
 * primeira mensagem de cada pessoa cair numa thread provisória, separando a
 * conversa em duas memórias.
 */
export async function runTurn(inbound: InboundMessage): Promise<string | null> {
  const texto = inbound.text?.trim() ?? "";
  const identity = await resolveIdentity(inbound.fromPhone);

  // Desconhecido não abre thread nem gasta modelo. Pode ser cliente que
  // respondeu a um aviso, engano ou spam.
  if (identity.kind === "unknown") {
    return (
      "Oi! Sou o Max, assistente das imobiliárias parceiras. Não reconheci " +
      "este número — fale com seu corretor para liberar o acesso."
    );
  }

  // Primeira vez com o telefone em mais de uma imobiliária: pergunta e para.
  if (identity.kind === "ambiguous") {
    return askWhichOrg(identity.candidates);
  }

  // Já perguntamos: esta mensagem PODE ser a resposta.
  if (identity.kind === "pending") {
    const escolhido = matchChoice(texto, identity.candidates);
    if (!escolhido) {
      // Não insistir com o texto igual seria pior — repetir a lista deixa claro
      // que o Max ainda está esperando, em vez de parecer que ignorou.
      return askWhichOrg(identity.candidates);
    }
    await saveChoice(inbound.fromPhone, escolhido.orgId);
    return (
      `Certo, ${escolhido.orgName}. Pode mandar sua pergunta que eu respondo ` +
      "com o material dessa imobiliária."
    );
  }

  const app = buildGraph().compile({ checkpointer: await getCheckpointer() });
  const result = await app.invoke(
    { inbound, identity: identity.candidate },
    {
      configurable: {
        thread_id: threadIdFor(identity.candidate.orgId, inbound.fromPhone),
      },
    }
  );

  return result.reply ?? null;
}
