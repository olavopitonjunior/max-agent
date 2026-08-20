import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  fetchProfile,
  searchKnowledge,
  reportUsage,
  transcribeMedia,
  criarFormularioVenda,
  criarFormularioLocacao,
  criarRascunhoProposta,
  brokerRecipientId,
  ModuloDesligadoError,
  type KnowledgeHit,
} from "@/lib/cm";
import {
  FORM_TOOL,
  TOOL_PROPOR_FORM,
  lerConfirmacao,
  lerFinalidade,
  lerTipo,
  podeEscrever,
  propostaExpirou,
  shouldOfferTools,
  textoCriado,
  textoModuloDesligado,
  textoProposta,
  TEXTO_CANCELADO,
  TEXTO_FALHOU,
  type PendingAction,
} from "./tools";
import { downloadMedia } from "@/lib/zapi";
import {
  loadFacts,
  saveFacts,
  extractFacts,
  renderFacts,
  type Facts,
} from "@/lib/memory";
import {
  resolveIdentity,
  matchChoice,
  saveChoice,
  askWhichOrg,
  displayName,
  markGreeted,
  type Candidate,
} from "@/lib/identity";
import { complete, DEFAULT_MODEL, type LlmUsage } from "@/lib/llm";
import { LLM_SHORT_TIMEOUT_MS } from "@/lib/http";
import { db } from "@/lib/db";
import { maskPhone } from "@/lib/phone";
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

  /**
   * O texto deste turn veio de áudio ou imagem transcritos, não digitados.
   *
   * Muda o prompt: a resposta reafirma o entendido na primeira frase. É a
   * correção mais barata que existe — se a transcrição errou um endereço ou um
   * valor, a pessoa percebe na primeira linha em vez de agir sobre a resposta
   * errada. Vale sobretudo em áudio, que não dá pra reler.
   */
  fromMedia: Annotation<"audio" | "image" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Fatos duráveis desta pessoa, carregados antes do grafo.
   *
   * Não confundir com `summary`: aquele é o histórico DESTA conversa comprimido
   * (lossy, some ao ser recomprimido); estes são frases curtas que sobrevivem a
   * qualquer compactação e a qualquer intervalo entre conversas.
   */
  facts: Annotation<Facts>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),

  /**
   * Escrita proposta e ainda não confirmada.
   *
   * Mora AQUI, no checkpoint, e em nenhum outro lugar. A alternativa considerada
   * era o `interrupt()` do LangGraph, e ela foi recusada: `interrupt()` modela
   * "o grafo está bloqueado esperando um valor", e conversa de WhatsApp não é
   * isso — a pessoa muda de assunto, corrige um campo, pergunta outra coisa. Um
   * grafo pausado ou força a resposta ou precisa ser abandonado, e obrigaria
   * `runTurn` a perguntar "esta thread está pausada?" a cada turn.
   *
   * Como estado comum, a fila de entrada não muda em nada: todo turn continua
   * sendo UM `invoke`, e `reply_text` segue separando "o grafo falhou" de "o
   * envio falhou". Duas verdades sobre pendência aqui reproduziriam o bug que a
   * `inbound_seen` causou.
   *
   * `reducer` que aceita `null` explicitamente: limpar a pendência é a operação
   * mais comum deste campo, e um `next ?? prev` a tornaria impossível.
   */
  pendingAction: Annotation<PendingAction | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Havia proposta pendente e esta mensagem não foi sim nem não.
   *
   * Só vale para o turn atual (o `answer` lê e o `compact` não guarda). Serve
   * para o Max reconhecer, numa frase, que deixou a criação de lado — sem isso
   * a proposta sumiria em silêncio e a pessoa poderia achar que foi criada.
   */
  propostaDescartada: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
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

/**
 * Resolve uma proposta pendente. **Não chama modelo.**
 *
 * É deliberado que este nó seja determinístico: o turn que EXECUTA uma escrita é
 * o mais caro de errar, e o `gpt-5.4-nano` seria mais uma fonte de variação
 * justamente ali. Custo do turn de confirmação: zero token.
 *
 * A pendência sobrevive no máximo UM turn. Mensagem que não é sim nem não a
 * descarta e a conversa segue normalmente — é o que garante que nenhuma thread
 * fique travada esperando uma confirmação que não vem. O TTL cobre o outro caso:
 * a próxima mensagem chega três dias depois e por acaso é "sim", respondendo
 * outra coisa na cabeça da pessoa.
 */
async function confirm(state: MaxStateType): Promise<MaxUpdate> {
  const pending = state.pendingAction;
  if (!pending) return {};

  const userText = state.inbound.text?.trim() || "";

  if (propostaExpirou(pending, Date.now())) {
    // Sem aviso: para a pessoa, uma proposta de meia hora atrás já saiu da
    // conversa. Anunciar o descarte reabriria um assunto que ela encerrou.
    return { pendingAction: null };
  }

  const resposta = lerConfirmacao(userText);

  if (resposta === "nao") {
    return {
      pendingAction: null,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: TEXTO_CANCELADO },
      ],
      reply: TEXTO_CANCELADO,
    };
  }

  if (resposta === "nenhum") {
    // Descarta e deixa o fluxo normal responder. O `answer` recebe o aviso e
    // reconhece numa frase que deixou a criação de lado.
    return { pendingAction: null, propostaDescartada: true };
  }

  // Confirmado. A partir daqui há escrita de verdade.
  const responder = (texto: string): MaxUpdate => ({
    pendingAction: null,
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: texto },
    ],
    reply: texto,
  });

  try {
    const url = await executar(
      state,
      pending.args,
      // A mensagem que CONFIRMOU, não um uuid novo: é o que faz a retentativa
      // devolver o mesmo documento em vez de criar um segundo.
      state.inbound.messageId
    );
    return responder(textoCriado({ url, args: pending.args }));
  } catch (err) {
    // Módulo desligado não é falha transitória: retentar não resolve, e quem
    // resolve não é quem pediu.
    if (err instanceof ModuloDesligadoError) {
      console.warn(`[confirm] ${err.message} em ${state.identity.orgId}`);
      return responder(textoModuloDesligado(pending.args));
    }
    console.error(
      "[confirm] criação falhou:",
      err instanceof Error ? err.message : String(err)
    );
    // Limpa a pendência mesmo na falha: mantê-la faria a próxima mensagem da
    // pessoa ser lida como confirmação de novo, e ela não confirmou duas vezes.
    return responder(TEXTO_FALHOU);
  }
}

/**
 * A escrita em si, por tipo. Devolve a URL absoluta para o texto de resposta.
 *
 * Fora do `confirm` para que aquele nó continue legível como máquina de estado:
 * lá se decide SE executa, aqui O QUE se executa.
 */
async function executar(
  state: MaxStateType,
  args: PendingAction["args"],
  idempotencyKey: string
): Promise<string> {
  const orgId = state.identity.orgId;
  const nome = args.nomeCliente;

  if (args.tipo === "proposta") {
    const proposta = await criarRascunhoProposta(orgId, {
      // `title` é obrigatório na rota; sem nome, um rótulo que diz de onde veio
      // é melhor que "Proposta" — quem abrir a lista amanhã sabe a origem.
      title: nome ? `Proposta — ${nome}` : "Proposta (criada pelo Max)",
      schemaType: "compra_venda_v1",
      idempotencyKey,
    });
    console.log(`[confirm] proposta ${proposta.id} criada para ${orgId}`);
    return proposta.url;
  }

  if (args.tipo === "locacao") {
    const form = await criarFormularioLocacao(orgId, {
      title: nome ? `Formulário — ${nome}` : undefined,
      finalidade: args.finalidade,
      idempotencyKey,
    });
    console.log(
      `[confirm] form de locação ${form.token} criado para ${orgId} (deal ${form.dealId})`
    );
    return form.url;
  }

  /**
   * `corretorIds` do `/api/forms` são ids de `SplitRecipient`, NÃO de `User` —
   * o where de lá é org-scoped e descarta id desconhecido em silêncio. Mandar
   * `identity.userId` não erraria: só deixaria o form sem comissionado e sem
   * notificação, sem ninguém perceber. O vínculo certo é pelo telefone, via
   * broker-scope. `null` é normal (gerente pede form sem ser comissionado) e
   * vira omissão — o Deal nasce do usuário de serviço de qualquer jeito.
   *
   * Só vendas: `POST /api/locacao/forms` não aceita este campo.
   */
  const recipientId = await brokerRecipientId(orgId, state.inbound.fromPhone);

  const form = await criarFormularioVenda(orgId, {
    title: nome ? `Formulário — ${nome}` : undefined,
    corretorIds: recipientId ? [recipientId] : undefined,
    idempotencyKey,
  });
  console.log(
    `[confirm] form ${form.token} criado para ${orgId} (deal ${form.dealId})`
  );
  return form.url;
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
    fromMedia: state.fromMedia,
    facts: renderFacts(state.facts),
    propostaDescartada: state.propostaDescartada,
    // Quem não pode escrever recebe um prompt que não descreve a ferramenta —
    // e diz de quem é o caminho. Descrever capacidade que não está no pedido é
    // a forma mais barata de um modelo pequeno prometer o que não entrega.
    podeEscrever: podeEscrever(state.identity),
  });

  const userText = state.inbound.text?.trim() || "(mensagem sem texto)";
  const history = state.messages.slice(-MAX_HISTORY);

  /**
   * A ferramenta só entra quando a mensagem plausivelmente pede escrita E quem
   * fala pode escrever. As duas condições são baratas e cortam o caso comum:
   * expor em todo turn custaria os tokens da definição sempre e daria ao nano
   * mais chance de chamar sem motivo.
   */
  const tools =
    podeEscrever(state.identity) && shouldOfferTools(userText)
      ? [FORM_TOOL]
      : undefined;

  let result;
  try {
    result = await complete({
      system,
      messages: [...history, { role: "user", content: userText }],
      model: state.model,
      tools,
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

  /**
   * O modelo pediu para propor uma escrita.
   *
   * **Não há segunda chamada ao modelo.** O texto da confirmação sai de template
   * a partir dos argumentos: é mais barato, e sobretudo confiável — o que a
   * pessoa lê para confirmar precisa ser exatamente o que será feito, e um nano
   * parafraseando isso anularia o sentido de confirmar.
   */
  const chamada = result.toolCalls.find((c) => c.name === TOOL_PROPOR_FORM);
  const tipo = chamada ? lerTipo(chamada.args.tipo) : null;

  /**
   * `tipo` fora do enum é chamada DESCARTADA, não adivinhada.
   *
   * O nano às vezes inventa um valor ("aluguel", "form"). Escolher o mais
   * parecido criaria a coisa errada com a confirmação da pessoa em cima —
   * ela leria "formulário de venda" e teria dito "aluguel". Sem tipo, o turn
   * cai no caminho de texto e ela repete o pedido.
   */
  if (chamada && !tipo) {
    console.warn(`[answer] tipo inválido na chamada: ${JSON.stringify(chamada.args)}`);
  }

  if (chamada && tipo) {
    const bruto = chamada.args.nome_cliente;
    const nomeCliente =
      typeof bruto === "string" && bruto.trim() ? bruto.trim().slice(0, 80) : undefined;

    const args: PendingAction["args"] = {
      tipo,
      nomeCliente,
      finalidade: lerFinalidade(chamada.args.finalidade),
    };
    const pending: PendingAction = {
      kind: "criar_documento",
      args,
      askedAt: Date.now(),
      askedForMessageId: state.inbound.messageId,
    };
    const texto = textoProposta(args);

    return {
      pendingAction: pending,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: texto },
      ],
      reply: texto,
    };
  }

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
      timeoutMs: LLM_SHORT_TIMEOUT_MS,
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

function afterGate(state: MaxStateType): "confirm" | typeof END {
  return state.halt ? END : "confirm";
}

/**
 * O `confirm` já respondeu?
 *
 * Ele responde quando executou, cancelou ou falhou — nos três casos o turn está
 * resolvido e passar pelo modelo seria pagar por uma resposta que já existe.
 * Vai direto pro `compact`, que ainda precisa rodar: o `confirm` acrescentou
 * turnos ao histórico como qualquer outro nó.
 */
function afterConfirm(state: MaxStateType): "retrieve" | "compact" {
  return state.reply ? "compact" : "retrieve";
}

export function buildGraph() {
  return new StateGraph(MaxState)
    .addNode("gate", gate)
    .addNode("confirm", confirm)
    .addNode("retrieve", retrieve)
    .addNode("answer", answer)
    .addNode("compact", compact)
    .addEdge(START, "gate")
    .addConditionalEdges("gate", afterGate, { confirm: "confirm", [END]: END })
    .addConditionalEdges("confirm", afterConfirm, {
      retrieve: "retrieve",
      compact: "compact",
    })
    .addEdge("retrieve", "answer")
    .addEdge("answer", "compact")
    .addEdge("compact", END);
}

let checkpointer: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    // A MESMA pool do resto do serviço, não uma segunda via `fromConnString`:
    // o `max: 3` do `db.ts` existe porque o Neon cobra por conexão, e uma pool
    // paralela sem teto furava essa contabilidade.
    checkpointer = new PostgresSaver(db());
    // `setup()` é DDL idempotente, mas rodar a cada cold start é uma rodada de
    // CREATE IF NOT EXISTS por instância. Depois do primeiro deploy com as
    // tabelas criadas, desligue com MAX_CHECKPOINTER_SETUP=0.
    if (process.env.MAX_CHECKPOINTER_SETUP !== "0") {
      await checkpointer.setup();
    }
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
export interface TurnResult {
  reply: string | null;
  /**
   * Trabalho que só pode acontecer DEPOIS de a resposta sair — hoje, a extração
   * de memória.
   *
   * É um thunk e não uma chamada direta de propósito: a promessa "fora do
   * caminho crítico" vira estrutura em vez de comentário. Quem chama não
   * consegue rodar isto antes de enviar sem escrever a linha errada de
   * propósito. Nunca lança.
   */
  afterReply?: () => Promise<void>;
}

export async function runTurn(inbound: InboundMessage): Promise<TurnResult> {
  const texto = inbound.text?.trim() ?? "";
  const identity = await resolveIdentity(inbound.fromPhone);

  // Desconhecido não abre thread nem gasta modelo. Pode ser cliente que
  // respondeu a um aviso, engano ou spam.
  if (identity.kind === "unknown") {
    // Uma apresentação por ciclo do cache negativo, e depois silêncio:
    // responder cada mensagem de um número estranho consome cota da Z-API e
    // confirma ao spammer que o número é vivo.
    if (identity.alreadyGreeted) return { reply: null };
    // Falhar em marcar só significa reapresentar na próxima — nunca vale
    // derrubar a resposta por isso.
    await markGreeted(inbound.fromPhone).catch(() => undefined);
    return {
      reply:
        "Oi! Sou o Max, assistente das imobiliárias parceiras. Não reconheci " +
        "este número — fale com seu corretor para liberar o acesso.",
    };
  }

  // Primeira vez com o telefone em mais de uma imobiliária: pergunta e para.
  if (identity.kind === "ambiguous") {
    return { reply: askWhichOrg(identity.candidates) };
  }

  // Já perguntamos: esta mensagem PODE ser a resposta.
  if (identity.kind === "pending") {
    // Mídia aqui não dá pra transcrever: a transcrição precisa do token de UMA
    // org, e é justamente a org que ainda não sabemos. Mandar o áudio pra
    // primeira candidata entregaria o conteúdo de alguém a uma imobiliária que
    // pode não ser a dele.
    if (!texto && inbound.kind !== "text") {
      return {
        reply:
          "Antes de continuar preciso saber de qual imobiliária você fala. " +
          "Responde por escrito, por favor:\n\n" +
          askWhichOrg(identity.candidates),
      };
    }
    const escolhido = matchChoice(texto, identity.candidates);
    if (!escolhido) {
      // Não insistir com o texto igual seria pior — repetir a lista deixa claro
      // que o Max ainda está esperando, em vez de parecer que ignorou.
      return { reply: askWhichOrg(identity.candidates) };
    }
    await saveChoice(inbound.fromPhone, escolhido.orgId);
    return {
      reply:
        `Certo, ${escolhido.orgName}. Pode mandar sua pergunta que eu respondo ` +
        "com o material dessa imobiliária.",
    };
  }

  /**
   * Áudio e imagem viram texto ANTES do grafo.
   *
   * Aqui, e não num nó: o transcrito passa a ser o turno da pessoa no histórico
   * e tudo depois dele — decidir se busca no RAG, montar o prompt, compactar —
   * funciona sem saber que a origem era voz. Um nó de transcrição obrigaria
   * cada etapa seguinte a lidar com "texto ou mídia".
   *
   * Depois da identidade porque a transcrição roda no ImobPro com o token DA
   * ORG: sem saber a org, não há credencial nem a quem cobrar o custo.
   */
  let turnText = texto;
  let fromMedia: "audio" | "image" | null = null;

  // Documento (e o que o parse não reconheceu) não tem transcrição — mas
  // silêncio é pior, e passar pelo modelo com "(mensagem sem texto)" pagava um
  // turn por uma resposta genérica. Template, sem LLM.
  if (!turnText && (inbound.kind === "document" || inbound.kind === "unknown")) {
    return {
      reply:
        inbound.kind === "document"
          ? "Ainda não consigo ler documentos por aqui. Me conta por escrito o " +
            "que você precisa?"
          : "Não consegui entender esse tipo de mensagem. Pode mandar por escrito?",
    };
  }

  if (!turnText && (inbound.kind === "audio" || inbound.kind === "image")) {
    fromMedia = inbound.kind;
    const transcrito = inbound.mediaUrl
      ? await transcreverMidia(identity.candidate.orgId, inbound)
      : null;

    if (!transcrito) {
      // Dizer que não deu, sempre. Silêncio faria a pessoa esperar resposta de
      // uma coisa que o agente nunca recebeu — e no WhatsApp ela não tem como
      // saber a diferença entre "ignorou" e "não chegou".
      return {
        reply:
          fromMedia === "audio"
            ? "Não consegui ouvir esse áudio. Pode me mandar por escrito?"
            : "Não consegui ver essa imagem. Pode me contar por escrito?",
      };
    }
    turnText = transcrito;
  }

  const orgId = identity.candidate.orgId;
  const phone = inbound.fromPhone;

  // Carregado ANTES do grafo, junto com o resto do que o prompt precisa. É
  // uma query indexada pela PK — mais barata que a busca semântica que o mesmo
  // turn já faz.
  const facts = await loadFacts(orgId, phone);

  const app = buildGraph().compile({ checkpointer: await getCheckpointer() });
  const result = await app.invoke(
    {
      inbound: { ...inbound, text: turnText },
      identity: identity.candidate,
      fromMedia,
      facts,
      /**
       * Campos de UM turn, zerados explicitamente na entrada.
       *
       * O checkpointer restaura o estado inteiro, inclusive o que só fazia
       * sentido no turn passado. `reply` é o caso grave: ele decide, no
       * `afterConfirm`, se o turn já foi resolvido — e restaurado do turn
       * anterior faria TODA mensagem pular o `retrieve`/`answer` e responder o
       * que já tinha sido respondido. `halt` e `propostaDescartada` têm o mesmo
       * defeito, menos visível.
       *
       * Só `messages`, `summary` e `pendingAction` atravessam turns de propósito.
       */
      reply: null,
      halt: null,
      propostaDescartada: false,
    },
    {
      configurable: {
        thread_id: threadIdFor(orgId, phone),
      },
    }
  );

  const reply = result.reply ?? null;

  return {
    reply,
    // Só vale extrair de um turn que teve as duas pontas: sem resposta não há
    // conversa da qual aprender, e um turn que falhou no modelo ensinaria o
    // erro.
    afterReply:
      reply && turnText
        ? async () => {
            const novos = await extractFacts({
              orgId,
              phone,
              userText: turnText,
              replyText: reply,
              known: facts,
            });
            const gravados = await saveFacts(orgId, phone, novos);
            if (gravados > 0) {
              console.log(`[memory] ${gravados} fato(s) de ${maskPhone(phone)} em ${orgId}`);
            }
          }
        : undefined,
  };
}

/** Baixa da Z-API e manda transcrever no ImobPro. `null` em qualquer tropeço. */
async function transcreverMidia(
  orgId: string,
  inbound: InboundMessage
): Promise<string | null> {
  const baixado = await downloadMedia(inbound.mediaUrl!);
  if (!baixado) return null;

  // O `mimeType` do webhook é o que a Z-API declara; o `content-type` do
  // download é o que o servidor de mídia respondeu. Preferir o do webhook e cair
  // no outro: nota de voz costuma vir certa lá e como `application/octet-stream`
  // aqui, e o Gemini precisa do tipo real pra decodificar.
  const mimeType =
    inbound.mimeType ??
    baixado.contentType ??
    (inbound.kind === "audio" ? "audio/ogg" : "image/jpeg");

  return transcribeMedia(orgId, {
    kind: inbound.kind === "audio" ? "audio" : "image",
    mimeType,
    data: baixado.data,
  });
}
