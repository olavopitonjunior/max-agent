import { interceptar, repassarDesconhecido } from "@/lib/aceite";
import { iniciarContinuidade, pedeContinuidade } from "./continuidade";
import { iniciarGestao, pedeGestao } from "./gestao";
import { pedeAcaoForaDoMax, pedeCapacidades, textoDeCapacidades, textoForaDoMax } from "./capacidades";
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
  TOOL_PROPOR_FORM,
  PENDING_TTL_MS,
  buscarNoRegistro,
  ferramentasDoTurno,
  pedidoEmAberto,
  lerConfirmacao,
  podeEscrever,
  propostaExpirou,
  querVerOResto,
  textoCriado,
  textoModuloDesligado,
  textoProposta,
  textoSemPermissao,
  modoDeCriacao,
  ehPedidoDeCriacao,
  textoCriacaoIndisponivel,
  TEXTO_INDISPONIVEL_AGORA,
  TEXTO_CANCELADO,
  textoFalhou,
  type PendingAction,
} from "./tools";
import { downloadMedia } from "@/lib/transport";
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
import { complete, DEFAULT_MODEL, type LlmUsage,
  type LlmToolCall,
} from "@/lib/llm";
import { LLM_SHORT_TIMEOUT_MS } from "@/lib/http";
import { checkpointerPool } from "@/lib/db";
import { conversationKey, phoneTag } from "@/lib/phone";
import { registrarTurn, type ToolLogEntry } from "@/lib/turnlog";
import {
  assuntoBloqueado,
  buildSystemPrompt,
  comoMensagemDoUsuario,
  pedeLeituraDeAnexo,
  shouldSearch,
  textoSemLeituraDeMidia,
  TEXTO_ASSUNTO_BLOQUEADO,
} from "./prompt";
import { limitarTamanho, sanitizar, travarCriacaoFalsa } from "./compose";
import { resolverPolitica, type Capability } from "./policy";
import {
  argsDaCriacao,
  autorizarChamada,
  autorizarPendencia,
  despacharLeituras,
  type ResultadoDeTool,
} from "./despachante";
import type { MapaDeReferencias } from "./referencias";
import {
  conduzirFluxo,
  fluxoExpirou,
  iniciarFluxo,
  lerEscolha,
  lerNatureza,
  pedeEnvio,
  rebaixarFluxo,
  retomarEnvio,
  SYSTEM_DA_EXTRACAO,
  TOOL_EXTRAIR_PROPOSTA,
  toolExtrairCampos,
  type DepsDoFluxo,
  type Fluxo,
} from "./fluxos";
import { executarAcao, type VerboDeAcao } from "@/lib/acao";
import { subjectDe } from "@/lib/scope";
import { chaveDePolitica } from "@/lib/cm";
import type { InboundMessage } from "@/lib/transport";
import { SEM_ORG } from "@/lib/sem-org";

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

/**
 * Teto de voltas do laço de ferramenta.
 *
 * Três razões, em ordem: orçamento de TEMPO (o turn vive numa function de 60 s
 * que já gastou identidade, transcrição e RAG), orçamento de DINHEIRO (cada
 * volta reenvia o histórico inteiro) e o fato de que um nano em laço não
 * converge.
 */
const TOOL_MAX_ROUNDS = 3;

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

// Mora no despachante, que é quem o produz. Reexportado: era daqui.
export type { ResultadoDeTool };

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

  hits: Annotation<KnowledgeHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /**
   * A resposta PRONTA para sair. Quem escreve aqui é template ou o `compose`.
   *
   * Texto do modelo nunca chega direto: ele entra por `draft` e só vira `reply`
   * depois do sanitizador. Ver o cabeçalho de `compose.ts`.
   */
  reply: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Texto CRU do modelo, ainda não sanitizado. **O único caminho de saída de
   * texto gerado.**
   *
   * Existe para que "só se sanitiza o que o modelo escreveu" seja uma
   * propriedade do GRAFO e não uma regra que alguém precise lembrar: o `answer`
   * não tem como publicar texto gerado sem passar pelo `compose`, porque não
   * escreve em `reply` no caminho de texto livre. O inverso também vale — o
   * link de formulário, que sai de template, não corre risco de ser comido pelo
   * padrão de id interno do sanitizador.
   */
  draft: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Padrões que o sanitizador derrubou neste turn. Auditoria, nunca prompt.
   *
   * Reducer de SUBSTITUIÇÃO (não acumula): é medida de um turn. E, ao contrário
   * de `usage`/`toolLog`, lista vazia aqui significa "passou limpo" e não
   * "zera" — por isso o reducer é `(_p, n) => n` e não tem sentinela.
   */
  bloqueios: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * Capabilities efetivas deste sujeito nesta org. Calculada no `gate`, uma vez.
   *
   * **Ninguém consome este campo ainda**, e isso é desenho, não pendência: o
   * consumo entra no PR 6, com as tools de leitura. Ligar a oferta de tool à
   * política agora derrubaria `propor_criacao` em produção durante a janela em
   * que o ImobPro ainda não emite a política — ver o cabeçalho de `policy.ts`.
   */
  policy: Annotation<Capability[]>({
    reducer: (_prev, next) => next,
    default: () => [],
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
   * O fluxo de criação em andamento (proposta ou negócio — `fluxos.ts`).
   *
   * ATRAVESSA turns de propósito, como `pendingAction`: a coleta de uma
   * proposta leva várias mensagens. Por isso NÃO está no `RESET_DO_TURN`. O
   * teto é o `FLUXO_TTL_MS` de inatividade, conferido no nó `conduzir`.
   */
  fluxo: Annotation<Fluxo | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Consumo do turn — uma entrada por CHAMADA de modelo, nunca somado.
   *
   * Um turn faz duas ou mais: resposta, compactação, extração de memória. Um
   * único número esconderia qual delas pesa, que é exatamente a pergunta de
   * quem olha o painel. Mesmo motivo pelo qual o `AIUsage` do ImobPro grava
   * uma linha por modelo.
   *
   * Acumula porque os nós contribuem em momentos diferentes do mesmo turn —
   * mas **lista vazia ZERA**, e isso não é detalhe: o checkpointer restaura o
   * estado inteiro, então sem um jeito de reiniciar, o consumo do turn passado
   * voltaria somado ao deste e o painel cobraria a mesma chamada para sempre.
   * É o mesmo defeito que o comentário do `reply` descreve, aplicado a número.
   * `runTurn` zera os dois na entrada, junto de `reply` e `halt`.
   */
  usage: Annotation<LlmUsage[]>({
    reducer: (prev, next) => (next.length === 0 ? [] : [...prev, ...next]),
    default: () => [],
  }),

  /**
   * Trilha do que o modelo PEDIU e do que aconteceu.
   *
   * Vai para a auditoria (`conversation_turn`), nunca para o prompt: nome de
   * ferramenta e argumento em JSON são encanamento, e encanamento não entra na
   * conversa. Registrar a chamada DESCARTADA é metade do valor — hoje um `tipo`
   * fora do enum só existe como um `console.warn` que ninguém correlaciona.
   */
  toolLog: Annotation<ToolLogEntry[]>({
    reducer: (prev, next) => (next.length === 0 ? [] : [...prev, ...next]),
    default: () => [],
  }),

  /**
   * Chamadas de LEITURA que o modelo pediu e ainda não foram executadas.
   *
   * Substitui, não acumula: são as do turno corrente do laço. O `tools` as
   * consome e devolve `[]`, que aqui significa "nenhuma pendente" — e não
   * "reset", porque este reducer não tem a semântica de reset dos de cima.
   */
  pendingToolCalls: Annotation<LlmToolCall[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * Quantas voltas do laço já aconteceram. Teto em `TOOL_MAX_ROUNDS`.
   *
   * Não é erro estourar: o `answer` responde com o que já coletou, e a trilha
   * registra `rounds_exhausted` para o painel mostrar.
   */
  toolRounds: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /**
   * O que as tools devolveram, para entrar no prompt cercado.
   *
   * ⚠️ Mesmo reducer de reset dos de cima (`[]` = zerar), então o nó `tools`
   * **nunca** espalha lista vazia: quando uma consulta falha, ele devolve uma
   * entrada de FALHA explícita. Apagar o que as voltas anteriores coletaram
   * faria o modelo responder sem o dado que ele já tinha, em silêncio.
   */
  toolResults: Annotation<ResultadoDeTool[]>({
    reducer: (prev, next) => (next.length === 0 ? [] : [...prev, ...next]),
    default: () => [],
  }),

  /**
   * Nomes das tools OFERECIDAS neste turn — a trava (b) do despachante.
   *
   * Do turn, não da volta: a oferta acontece só na volta 0, e as voltas
   * seguintes ainda executam o que foi oferecido nela. Zerado no
   * `RESET_DO_TURN`; substitui (lista vazia aqui é "nada oferecido", não
   * reset).
   */
  toolsOferecidas: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  /**
   * Quanto cada nó levou neste turn, na ordem em que rodaram (`cronometrar`).
   * Vai para `conversation_turn.timings_json`: é o que diz ONDE o p95 mora
   * antes de qualquer mudança no grafo. Mesmo reducer de reset dos de cima
   * (`[]` = zerar), e zerado no `RESET_DO_TURN`.
   */
  timings: Annotation<TimingDeNo[]>({
    reducer: (prev, next) => (next.length === 0 ? [] : [...prev, ...next]),
    default: () => [],
  }),

  /**
   * G2 — número → id da última lista mostrada. ATRAVESSA turns de propósito:
   * "e a 2?" chega na mensagem seguinte. O prazo é o `REFERENCIA_TTL_MS`,
   * conferido por `resolverReferencia` na hora do uso — mapa vencido continua
   * no checkpoint e é recusado, até a próxima lista substituí-lo.
   */
  referencias: Annotation<MapaDeReferencias | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * G6 — o que o teto de tamanho cortou da última resposta. Atravessa UM turn
   * (como a pendência): se a mensagem seguinte pede o resto, o `continuar`
   * manda; qualquer outra coisa o descarta.
   */
  restoDaResposta: Annotation<{ texto: string; criadoEm: number } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * A política deste turn é `[]` por FALHA (perfil ou chave de papel fora do
   * ar), e não por decisão da org. Fail-closed do mesmo jeito — muda só o
   * TEXTO: "não consegui verificar agora" em vez de "não está liberado para
   * você" (achado D4). Do turn: zerado no `RESET_DO_TURN`.
   */
  politicaIndisponivel: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
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
 *
 * O telefone passa por `conversationKey` e NÃO entra cru. Antes entrava, e a
 * mesma pessoa ganhava uma thread por formato de entrada — `5511…` pelo webhook
 * da Z-API, `+5511…` por qualquer chamador que normalizasse antes. Duas
 * conversas paralelas, duas memórias, nenhum erro. Normalizar AQUI, e não em
 * cada call-site, é o que impede o próximo caminho de entrada de reabrir o bug.
 */
export function threadIdFor(orgId: string, phone: string): string {
  return `${orgId}:${conversationKey(phone)}`;
}

/**
 * Semeia o thread com uma notificação PROATIVA enviada.
 *
 * Obrigação escrita em `contractmaker/docs/max.md` (§ superfície do serviço)
 * e nunca implementada: quem respondia "o que é isso?" a um aviso chegava a
 * um grafo que não sabia de aviso nenhum. A notificação vira um turno do
 * assistente no checkpoint — o `answer` passa a enxergá-la no histórico como
 * qualquer outra fala do Max.
 *
 * Chamado DEPOIS do envio bem-sucedido (nunca no aceite do `/notify`): uma
 * mensagem represada pela janela 7h–22h não pode aparecer no thread antes de
 * existir no WhatsApp. Falha aqui não desfaz envio — quem chama cerca com
 * catch próprio.
 */
export async function seedNotification(
  orgId: string,
  phone: string,
  texto: string
): Promise<void> {
  const app = await getApp();
  await app.updateState(
    { configurable: { thread_id: threadIdFor(orgId, phone) } },
    { messages: [{ role: "assistant", content: texto }] }
  );
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
  let perfilFalhou = false;
  // Perfil e chave de papel são duas idas ao ImobPro que não dependem uma da
  // outra: em paralelo, o gate custa a mais lenta, não a soma. A chave é lida
  // mesmo quando o kill switch ou a deny-list vão cortar o turn — é uma
  // leitura, e o halt é a exceção, não o caso que se otimiza.
  const [profile, chave] = await Promise.all([
    fetchProfile(state.identity.orgId).catch((err) => {
      console.warn("[graph] perfil indisponível, seguindo:", err?.message ?? err);
      perfilFalhou = true;
      return null;
    }),
    // `.catch` porque `orgById` fica fora do try de `chaveDePolitica`: uma
    // rejeição aqui derrubaria o gate inteiro, inclusive o kill switch.
    state.identity.kind === "user"
      ? chaveDePolitica(state.identity.orgId, state.inbound.fromPhone).catch(() => null)
      : Promise.resolve<string | null>(null),
  ]);

  /**
   * Todo `halt` DESCARTA a pendência, e isso não é higiene: é consentimento.
   *
   * O `halt` desvia do `confirm`, então uma proposta pendente atravessava o
   * turn intocada — furando a invariante "a pendência sobrevive no máximo UM
   * turn" que o cabeçalho do `confirm` promete. O desfecho ruim é concreto: o
   * Max pergunta "crio o formulário do João?", a mensagem seguinte cai na
   * deny-list e é recusada, e a mensagem DEPOIS dessa — um "sim" que a pessoa
   * já dava por encerrado — executa a escrita. O TTL de 30 min estreita a
   * janela, não a fecha.
   *
   * Vale igual para o kill switch, onde o defeito é anterior a esta entrega:
   * agente desligado tem que descartar, nunca guardar escrita para executar
   * quando voltar.
   */
  if (profile && !profile.enabled) {
    return {
      halt: "desligado",
      pendingAction: null,
      restoDaResposta: null,
      fluxo: rebaixarFluxo(state.fluxo),
      reply:
        "No momento estou indisponível. Fale com seu corretor por enquanto — " +
        "sua imobiliária já foi avisada.",
    };
  }

  /**
   * Deny-list de assunto — DEPOIS do kill switch, de propósito.
   *
   * Um agente desligado que respondesse "não falo da minha configuração"
   * mentiria sobre o próprio estado: quem está desligado está indisponível, e é
   * isso que a pessoa precisa ouvir. (Perfil e chave de papel já foram lidos em
   * paralelo no topo; a ordem aqui é só de qual resposta vence.)
   *
   * Daqui pra frente é que vale o "custo zero" de MODELO: o corte acontece
   * antes do RAG e antes do modelo. Sondar o Max não gasta token nem embedding,
   * e a resposta é a mesma em toda tentativa — determinismo é metade do valor
   * de uma recusa.
   *
   * Não entra no histórico (o `halt` corta antes do `compact` e nenhum nó
   * acrescenta `messages`): a pergunta bloqueada não vira contexto do turno
   * seguinte, o que é exatamente o que se quer de uma tentativa de sondagem.
   */
  const bloqueado = assuntoBloqueado(state.inbound.text ?? "");
  if (bloqueado) {
    console.warn(
      `[gate] assunto bloqueado (${bloqueado}) em ${state.identity.orgId}`
    );
    return {
      halt: `assunto_bloqueado:${bloqueado}`,
      // Ver o descarte no kill switch acima: `halt` desvia do `confirm`, e uma
      // pendência que atravessa o turn vira escrita confirmada por engano.
      pendingAction: null,
      restoDaResposta: null,
      fluxo: rebaixarFluxo(state.fluxo),
      reply: TEXTO_ASSUNTO_BLOQUEADO,
    };
  }

  /**
   * G5 — pedido por TEXTO para ler foto/PDF enviado: mesma frase fixa da
   * mídia, sem modelo (ver `pedeLeituraDeAnexo`). Mesmo lugar e mesmas regras
   * da deny-list: custo zero, descarta pendência e resto, não entra no
   * histórico nem na memória (`halt`).
   */
  if (pedeLeituraDeAnexo(state.inbound.text ?? "")) {
    return {
      halt: "pede_leitura_de_anexo",
      pendingAction: null,
      restoDaResposta: null,
      fluxo: rebaixarFluxo(state.fluxo),
      reply: textoSemLeituraDeMidia(null),
    };
  }

  /**
   * Política efetiva, resolvida UMA vez por turn e guardada no estado.
   *
   * Resolver aqui, e não por chamada de tool, é o que evita multiplicar
   * round-trips dentro do laço do PR 6. E resolver mesmo sem consumidor é o
   * que permite VER a política em produção — pela auditoria — antes de ela
   * passar a decidir alguma coisa.
   *
   * Perfil indisponível cai em `null`, que resolve para nenhuma capability.
   * Isso é fail-closed (regra 3) e é seguro justamente porque nada filtra tool
   * por política ainda.
   */
  /**
   * A chave vem do SERVIDOR, por turn — nunca do candidato.
   *
   * O candidato é gravado na `phone_org_choice`, que não tem TTL, então um
   * papel guardado ali congela: rebaixar alguém na plataforma não revogava o
   * que o Max oferece. Buscar aqui custa um round-trip por turn e é o que
   * mantém a chave fresca e ciente de papel customizado.
   *
   * Corretor comissionado não tem papel — a política dele é `brokerDefault` +
   * `byRecipient` —, então nem chamamos.
   *
   * ⚠️ **Falha vira `null`, nunca o último valor conhecido.** Buscar por turn
   * troca "papel congelado" por "papel indisponível", e a degradação tem que
   * cair no MENOR privilégio: guardar um valor anterior para usar quando a rota
   * cai reintroduziria exatamente o congelamento, e com pior sincronismo.
   */
  // (`chave` foi lida no topo do gate, em paralelo com o perfil.)
  const policy = resolverPolitica({
    politica: profile?.maxPolicy,
    sujeito: state.identity,
    role: chave,
  });

  /**
   * A política resolvida vai para o LOG, e isto não é enfeite.
   *
   * O comentário acima afirma que resolver sem consumidor "permite VER a
   * política em produção" — e, sem esta linha, a afirmação era falsa: nada em
   * `conversation_turn` guarda a política, nenhum campo do `TurnLog` a carrega,
   * e no smoke de staging não haveria como distinguir "resolveu [] porque o
   * ImobPro ainda não emite" de "resolveu 3 capabilities". A promessa do PR 4
   * inteiro é ser observável enquanto é inerte; um comentário não entrega isso.
   *
   * Conta e nomes, não o objeto: são no máximo 9 strings de catálogo, nenhuma
   * é dado de pessoa, e é exatamente o que se quer ler no smoke.
   */
  console.info(
    `[gate] política de ${state.identity.orgId}: ${policy.length} capability(ies)` +
      (policy.length ? ` — ${policy.join(",")}` : " (fail-closed)")
  );

  // `profile.model` é IGNORADO de propósito: aquele campo carrega id de modelo
  // Anthropic e este runtime fala com o OpenRouter. O registry do ImobPro já
  // declara `supports.model: false` pro Max — a tela não oferece o controle
  // justamente porque ele não valeria nada aqui.
  //
  // `profile.instructions` também não é mais lido: o prompt do Max é GLOBAL da
  // plataforma (decisão 1 do PRD do copiloto). O perfil continua sendo buscado
  // porque dele vêm `enabled` e, no PR 7, a seleção de modelo.
  /**
   * `null` na chave de um USUÁRIO é tratado como indisponibilidade: o
   * `chaveDePolitica` devolve `null` tanto em falha de rede quanto em
   * membership degenerada, e para quem o Max já identificou como usuário a
   * segunda é anomalia. Nos dois casos o texto certo é "tente de novo", não
   * "você não pode". Só muda a mensagem — a política continua `[]`.
   */
  const politicaIndisponivel =
    perfilFalhou || !profile || (state.identity.kind === "user" && chave === null);

  return { policy, politicaIndisponivel };
}

/**
 * G6 — manda o resto de uma resposta cortada, se a pessoa pediu. **Sem modelo.**
 *
 * Roda antes do `confirm` e nunca disputa com ele: o turn que cria pendência
 * responde por template (sem corte, sem resto), e o resto de um turn anterior
 * já foi descartado aqui quando a mensagem não pedia continuação. Os dois
 * nunca coexistem.
 *
 * O resto sobrevive no máximo UM turn, com o mesmo prazo da pendência: "sim"
 * três horas depois responde outra coisa na cabeça da pessoa.
 */
async function continuar(state: MaxStateType): Promise<MaxUpdate> {
  const guardado = state.restoDaResposta;
  if (!guardado) return {};

  const vale =
    !state.pendingAction &&
    Date.now() - guardado.criadoEm <= PENDING_TTL_MS &&
    querVerOResto(state.inbound.text ?? "");
  if (!vale) return { restoDaResposta: null };

  // O resto passa pelo MESMO teto: um texto de 1500 caracteres sai em três
  // pedaços, cada um com o seu "Quer ver o resto?".
  const { texto, resto } = limitarTamanho(guardado.texto);
  return {
    reply: texto,
    restoDaResposta: resto ? { texto: resto, criadoEm: Date.now() } : null,
    messages: [
      { role: "user", content: state.inbound.text?.trim() || "" },
      { role: "assistant", content: texto },
    ],
  };
}

/**
 * As dependências do fluxo neste turn: o `scope-action` como ESTA pessoa
 * (sujeito + telefone, reconferidos no servidor) e o extrator por ferramenta
 * obrigatória. O consumo das extrações entra em `usage` do turn.
 */
function depsDoFluxo(state: MaxStateType, usage: LlmUsage[]): DepsDoFluxo {
  const orgId = state.identity.orgId;
  const extrair = async (texto: string, tool: { name: string; description: string; parameters: Record<string, unknown> }) => {
    try {
      const r = await complete({
        system: SYSTEM_DA_EXTRACAO,
        messages: [{ role: "user", content: comoMensagemDoUsuario(texto) }],
        model: state.model,
        tools: [tool],
        toolChoice: tool.name,
        timeoutMs: LLM_SHORT_TIMEOUT_MS,
      });
      usage.push(r.usage);
      void reportUsage(orgId, r.usage);
      return r.toolCalls.find((c) => c.name === tool.name)?.args ?? {};
    } catch (err) {
      console.error("[fluxo] extração falhou:", err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  return {
    acao: (verb, args, idempotencyKey) =>
      executarAcao({
        orgId,
        rawPhone: state.inbound.fromPhone,
        subject: subjectDe(state.identity),
        verb: verb as VerboDeAcao,
        args,
        idempotencyKey,
      }),
    extrairProposta: async (texto) => extrair(texto, TOOL_EXTRAIR_PROPOSTA as never),
    extrairCampos: async (texto, campos) =>
      (await extrair(texto, toolExtrairCampos(campos))) as Record<string, string> | null,
  };
}

/**
 * Um turn com fluxo de criação em andamento. Responde por template e decide o
 * passo seguinte; sem fluxo (ou vencido), passa adiante sem tocar em nada.
 */
async function conduzir(state: MaxStateType): Promise<MaxUpdate> {
  const agora = Date.now();
  const userText = state.inbound.text?.trim() || "";
  const usage: LlmUsage[] = [];
  const vencido = state.fluxo && fluxoExpirou(state.fluxo, agora);
  // Expira a CONFIRMAÇÃO, não a referência ao negócio nem a chave de retry.
  // Vencida, a gestão só sobrevive com escrita incerta (a chave): seleção ou
  // resumo velhos não podem capturar um "2" dias depois (review 09/10).
  const sobrevive = state.fluxo?.kind === "continuidade" || (state.fluxo?.kind === "gestao" && !!state.fluxo.chave);
  const atual = vencido ? (sobrevive ? rebaixarFluxo(state.fluxo) : null) : state.fluxo;
  const escritaEmAberto = !!(atual && "chave" in atual && atual.chave);

  // O que o Max faz, e o que não faz (contrato, cobrança): resposta do
  // sistema, nunca do modelo (prod 09/10). O fluxo em curso fica como está.
  // Nunca no meio de uma coleta: "forma de pagamento: boleto" é dado da proposta.
  const coletando = atual?.kind === "proposta" || atual?.kind === "negocio" || atual?.kind === "escolha";
  // Continuidade e gestão vêm antes: "converte a proposta… pra gerar o contrato" é conversão.
  const gestao = podeEscrever(state.identity) && !coletando && atual?.kind !== "gestao" ? pedeGestao(userText) : null;
  const continuidade = podeEscrever(state.identity) && pedeContinuidade(userText);
  const foraDoMax = coletando || gestao || continuidade ? null : pedeAcaoForaDoMax(userText);
  if (!coletando && !gestao && !continuidade && (foraDoMax || pedeCapacidades(userText))) {
    const resultado = state.fluxo?.kind === "continuidade" ? state.fluxo.resultado : undefined;
    const linkDoNegocio = resultado?.match(/Negócio: (\S+)/)?.[1] ?? null;
    const reply = foraDoMax
      ? textoForaDoMax(foraDoMax, linkDoNegocio)
      : textoDeCapacidades(state.policy, podeEscrever(state.identity));
    return { reply, pendingAction: null, messages: [{ role: "user", content: userText }, { role: "assistant", content: reply }],
      toolLog: [{ name: "fluxo", args: { kind: "escopo" }, outcome: foraDoMax ? `fora_do_max_${foraDoMax}` : "capacidades" }] };
  }

  // Excluir/duplicar proposta: fluxo próprio, determinístico (decisão 09/10).
  if (gestao && !escritaEmAberto) {
    const passo = await iniciarGestao(gestao, { texto: userText, messageId: state.inbound.messageId,
      policy: state.policy, politicaIndisponivel: state.politicaIndisponivel, agora }, depsDoFluxo(state, usage));
    return { fluxo: passo.fluxo, reply: passo.reply,
      messages: [{ role: "user", content: userText }, { role: "assistant", content: passo.reply }],
      toolLog: [{ name: "fluxo", args: { kind: "gestao", operacao: gestao }, outcome: passo.evento }] };
  }

  // Continuidade tem precedência sobre o classificador "criar formulário".
  if (atual?.kind !== "continuidade" && continuidade && !(escritaEmAberto && atual?.kind === "gestao")) {
    const passo = await iniciarContinuidade({ texto: userText, messageId: state.inbound.messageId,
      policy: state.policy, politicaIndisponivel: state.politicaIndisponivel, agora }, depsDoFluxo(state, usage));
    return { fluxo: passo.fluxo, reply: passo.reply,
      messages: [{ role: "user", content: userText }, { role: "assistant", content: passo.reply }],
      toolLog: [{ name: "fluxo", args: { kind: "continuidade" }, outcome: passo.evento }] };
  }

  // Sem fluxo (ou vencido) e a pessoa pede o ENVIO: retoma do rascunho dela —
  // nunca deixar o modelo livre "enviar" (prod 07/10).
  // Fluxo de criação que ainda não colheu nada (escolha 1/2, venda ou locação)
  // não segura um pedido de envio de proposta existente.
  // ...a não ser que a mensagem também RESPONDA a pergunta aberta (code review:
  // "proposta, e já manda pra ela" é a escolha, não o envio de um rascunho velho).
  const naoComecou =
    !atual ||
    (atual.kind === "escolha" && !lerEscolha(userText)) ||
    (atual.kind === "negocio" && atual.etapa === "tipo" && !lerNatureza(userText)) ||
    (atual.kind === "proposta" && atual.etapa === "natureza" && !lerNatureza(userText)) ||
    (atual.kind === "proposta" && atual.etapa === "selecao_envio") ||
    (atual.kind === "gestao" && !atual.chave);
  if (naoComecou && podeEscrever(state.identity) && pedeEnvio(userText)) {
    const passo = await retomarEnvio(
      {
        texto: userText,
        messageId: state.inbound.messageId,
        policy: state.policy,
        politicaIndisponivel: state.politicaIndisponivel,
        agora,
      },
      depsDoFluxo(state, usage),
      state.fluxo
    );
    return {
      fluxo: passo.fluxo,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: passo.reply },
      ],
      reply: passo.reply,
      ...(usage.length > 0 ? { usage } : {}),
      toolLog: [{ name: "fluxo", args: { kind: "envio" }, outcome: passo.evento }],
    };
  }
  if (!atual) return vencido ? { fluxo: null } : {};

  const passo = await conduzirFluxo(
    atual,
    {
      texto: userText,
      messageId: state.inbound.messageId,
      policy: state.policy,
      politicaIndisponivel: state.politicaIndisponivel,
      agora,
    },
    depsDoFluxo(state, usage)
  );
  if (passo.liberar) {
    // A mensagem não era do fluxo (pergunta, conversa): segue para o
    // atendimento normal — sem "Anotado" falso. O fluxo fica, mas REBAIXADO:
    // se a resposta do modelo terminar em pergunta, o "sim" a ela não pode
    // criar nem enviar (achado N1 do code review).
    return {
      fluxo: passo.fluxo === null ? null : rebaixarFluxo(atual),
      ...(usage.length > 0 ? { usage } : {}),
      toolLog: [{ name: "fluxo", args: { kind: atual.kind }, outcome: passo.evento }],
    };
  }
  return {
    fluxo: passo.fluxo,
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: passo.reply },
    ],
    reply: passo.reply,
    ...(usage.length > 0 ? { usage } : {}),
    // Sem os DADOS: o que a pessoa ditou (CPF, telefone) não vai para o log.
    toolLog: [{ name: "fluxo", args: { kind: atual.kind }, outcome: passo.evento }],
  };
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
    return {
      pendingAction: null,
      propostaDescartada: true,
      toolLog: [
        { name: TOOL_PROPOR_FORM, args: { ...pending.args }, outcome: "descartada" },
      ],
    };
  }

  // Confirmado. A partir daqui há escrita de verdade — e é o evento mais
  // importante da trilha: é o único ponto em que o Max muda dado do tenant.
  const responder = (texto: string, outcome: string): MaxUpdate => ({
    pendingAction: null,
    messages: [
      { role: "user", content: userText },
      { role: "assistant", content: texto },
    ],
    reply: texto,
    toolLog: [
      { name: TOOL_PROPOR_FORM, args: { ...pending.args }, outcome },
    ],
  });

  // A política é do turn do "sim", não do turn da pergunta (ver
  // `autorizarPendencia`). Recusa limpa a pendência e diz que nada foi criado.
  const auth = autorizarPendencia({
    pending,
    policy: state.policy,
    identity: state.identity,
  });
  if (!auth.ok) {
    console.warn(`[confirm] escrita recusada (${auth.motivo}) em ${state.identity.orgId}`);
    // Falha transitória ao conferir ≠ "não liberado". A pendência cai nos
    // dois casos: um "sim" não pode valer depois sem pergunta nova.
    if (auth.motivo === "capability_negada" && state.politicaIndisponivel) {
      return responder(TEXTO_INDISPONIVEL_AGORA, "politica_indisponivel");
    }
    return responder(textoSemPermissao(pending.args), auth.motivo);
  }

  try {
    const url = await executar(
      state,
      pending.args,
      // A mensagem que CONFIRMOU, não um uuid novo: é o que faz a retentativa
      // devolver o mesmo documento em vez de criar um segundo.
      state.inbound.messageId
    );
    return responder(textoCriado({ url, args: pending.args }), "criado");
  } catch (err) {
    // Módulo desligado não é falha transitória: retentar não resolve, e quem
    // resolve não é quem pediu.
    if (err instanceof ModuloDesligadoError) {
      console.warn(`[confirm] ${err.message} em ${state.identity.orgId}`);
      return responder(textoModuloDesligado(pending.args), "modulo_desligado");
    }
    console.error(
      "[confirm] criação falhou:",
      err instanceof Error ? err.message : String(err)
    );
    // Limpa a pendência mesmo na falha: mantê-la faria a próxima mensagem da
    // pessoa ser lida como confirmação de novo, e ela não confirmou duas vezes.
    return responder(textoFalhou(pending.args), "falhou");
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
    // A natureza decide o schema — os três já existiam na rota (`cm.ts`), o
    // hardcode aqui era o que deixava proposta de locação inexistente por
    // conversa. Default venda: valor fora do enum já virou undefined no parse.
    const schemaType =
      args.natureza === "locacao"
        ? args.finalidade === "comercial"
          ? ("locacao_comercial_v1" as const)
          : ("locacao_residencial_v1" as const)
        : ("compra_venda_v1" as const);
    const proposta = await criarRascunhoProposta(orgId, {
      // `title` é obrigatório na rota; sem nome, um rótulo que diz de onde veio
      // é melhor que "Proposta" — quem abrir a lista amanhã sabe a origem.
      title: nome ? `Proposta — ${nome}` : "Proposta (criada pelo Max)",
      schemaType,
      idempotencyKey,
      // O rascunho fica com quem pediu. Só usuário da plataforma tem `userId`;
      // o corretor comissionado sem login nem chega aqui (`podeEscrever`).
      responsibleUserId: state.identity.kind === "user" ? state.identity.userId : undefined,
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
  /**
   * B1 — a seção de criação do prompt e a oferta da tool vêm do MESMO
   * predicado (`modoDeCriacao` → `escritaPermitida`, o que `ferramentasDoTurno`
   * usa). Antes o prompt olhava só `podeEscrever`: sem política, ele mandava
   * "use a ferramenta" sem ferramenta nenhuma, e o nano encenava "pronto,
   * criei".
   */
  const criacao = modoDeCriacao(state.identity, state.policy);
  const pedidoBruto = state.inbound.text?.trim() || "";

  // Pedido EXPLÍCITO de criação a quem não pode criar agora: template, sem
  // modelo — é onde o nano mais tende a encenar a ação. Só na volta 0.
  if (state.toolRounds === 0 && criacao !== "disponivel" && ehPedidoDeCriacao(pedidoBruto)) {
    const texto = textoCriacaoIndisponivel(criacao, state.politicaIndisponivel);
    return {
      toolsOferecidas: [],
      messages: [
        { role: "user", content: pedidoBruto },
        { role: "assistant", content: texto },
      ],
      reply: texto,
    };
  }

  const system = buildSystemPrompt({
    orgName: state.identity.orgName,
    userName: displayName(state.identity),
    hits: state.hits,
    summary: state.summary,
    fromMedia: state.fromMedia,
    facts: renderFacts(state.facts),
    propostaDescartada: state.propostaDescartada,
    // Quem não pode criar recebe um prompt que não descreve a ferramenta — e
    // diz de quem é o caminho. Descrever capacidade que não está no pedido é
    // a forma mais barata de um modelo pequeno prometer o que não entrega.
    criacao,
    // Vazio na primeira volta; preenchido quando o `tools` já rodou.
    toolResults: state.toolResults,
  });

  const userText = state.inbound.text?.trim() || "(mensagem sem texto)";
  const history = state.messages.slice(-MAX_HISTORY);

  /**
   * O que entra no prompt deste turn — escrita E leitura pelo MESMO crivo
   * (`ferramentasDoTurno`): política, identidade e prefiltro (G4).
   *
   * A `propor_criacao` passou a obedecer à política neste PR. Antes era
   * oferecida por `podeEscrever && shouldOfferTools`, sem política, porque
   * nenhuma org concedia `form.create`; o `POLITICA_PADRAO` do ImobPro agora
   * concede `form.create` e `proposal.create` a todo papel. Perfil fora do ar
   * = sem escrita neste turn (fail-closed).
   *
   * Nas voltas seguintes do laço nada de novo é oferecido: o modelo já tem o
   * resultado e o que se espera dele é a resposta, não outra chamada. O que
   * foi oferecido na volta 0 continua valendo para o despachante (trava b).
   */
  const oferta =
    state.toolRounds === 0
      ? ferramentasDoTurno({
          policy: state.policy,
          texto: userText,
          identity: state.identity,
          textoAnterior: pedidoEmAberto(history),
        })
      : { entradas: [], cortadas: 0 };

  if (oferta.cortadas > 0) {
    // Corte silencioso viraria "a feature não funciona às vezes".
    console.info(
      `[answer] teto de tools cortou ${oferta.cortadas} em ${state.identity.orgId}`
    );
  }

  const oferecidas =
    state.toolRounds === 0 ? oferta.entradas.map((e) => e.nome) : state.toolsOferecidas;
  // Só a volta 0 grava: as seguintes herdam a oferta do turn.
  const daOferta = state.toolRounds === 0 ? { toolsOferecidas: oferecidas } : {};
  const defs = oferta.entradas.map((e) => e.def);
  const tools = defs.length > 0 ? defs : undefined;

  let result;
  try {
    result = await complete({
      system,
      // G7: todo texto da PESSOA vai escapado (não forja cerca nossa) — o do
      // histórico também, porque uma injeção de três turns atrás continua no
      // prompt. Sem etiqueta em volta: medido, ela derrubava a escolha de
      // tool (ver `comoMensagemDoUsuario`). O histórico guarda o texto cru.
      messages: [...history, { role: "user" as const, content: userText }].map(
        (m): ChatMessage =>
          m.role === "user" ? { ...m, content: comoMensagemDoUsuario(m.content) } : m
      ),
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
      ...daOferta,
      messages: [{ role: "user", content: userText }],
      // O turn que falhou também custou, e a auditoria precisa mostrar isso —
      // um agente que só erra não pode aparecer como um agente que não gasta.
      //
      // Espalhado condicionalmente, e não `usage ? [usage] : []`: lista vazia
      // é o SINAL DE RESET do reducer, então mandar `[]` para dizer "não tenho
      // dado" e para dizer "zera tudo" seria o mesmo valor com dois
      // significados. Hoje seria inofensivo (nada contribui `usage` antes do
      // `answer`), e é exatamente por isso que precisa ser corrigido agora.
      ...(usage ? { usage: [usage] } : {}),
      reply:
        "Tive um problema pra responder agora. Tenta de novo em instantes, " +
        "ou fala com seu corretor se for urgente.",
    };
  }

  // Fire-and-forget: perder a contabilidade de um turn é ruim; não responder
  // ao usuário por causa dela é pior.
  void reportUsage(state.identity.orgId, result.usage);
  const usageDoTurn: LlmUsage[] = [result.usage];

  /**
   * O modelo pediu para propor uma escrita.
   *
   * **Não há segunda chamada ao modelo.** O texto da confirmação sai de template
   * a partir dos argumentos: é mais barato, e sobretudo confiável — o que a
   * pessoa lê para confirmar precisa ser exatamente o que será feito, e um nano
   * parafraseando isso anularia o sentido de confirmar.
   *
   * Passa pelo despachante como qualquer chamada: existe, foi oferecida, a
   * política concede a capability DESTE tipo, e quem fala pode escrever.
   */
  const trilha: ToolLogEntry[] = [];
  for (const c of result.toolCalls) {
    // Nome fora do registro: registrado e ignorado, como antes (sem volta de
    // laço por ele). Antes sumia sem rastro.
    if (!buscarNoRegistro(c.name)) {
      trilha.push({ name: c.name, args: c.args, outcome: "tool_desconhecida" });
    }
  }

  const chamada = result.toolCalls.find((c) => buscarNoRegistro(c.name)?.tipo === "escrita");
  if (chamada) {
    const auth = autorizarChamada({
      chamada,
      oferecidas,
      policy: state.policy,
      identity: state.identity,
    });

    if (auth.ok) {
      // `auth.ok` garante tipo válido (`capabilityDaChamada` não foi null).
      // O pedido de criação abre um FLUXO (`fluxos.ts`), não uma pendência de
      // um passo: proposta pede escolha + coleta + rascunho + assinatura, e
      // negócio pede os obrigatórios do popup. Todo texto daqui é template.
      const args = argsDaCriacao(chamada.args, displayName(state.identity))!;
      // Já há um fluxo em andamento (a mensagem passou por ele e foi liberada):
      // começar outro apagaria o rascunho em curso e os dados colhidos.
      if (state.fluxo) {
        const emAndamento =
          state.fluxo.kind === "negocio"
            ? "um formulário de negócio"
            : state.fluxo.kind === "proposta"
              ? "uma proposta"
              : "um pedido de criação";
        const texto =
          `Você já tem ${emAndamento} em andamento comigo. Continue por aqui, ` +
          "ou diga CANCELAR para começar outro.";
        return {
          ...daOferta,
          messages: [
            { role: "user", content: userText },
            { role: "assistant", content: texto },
          ],
          reply: texto,
          usage: usageDoTurn,
          toolLog: [...trilha, { name: chamada.name, args: { tipo: args.tipo }, outcome: "fluxo_em_andamento" }],
        };
      }
      const extra: LlmUsage[] = [];
      let passo = await iniciarFluxo(
        {
          tipo: args.tipo,
          natureza: args.natureza ?? (args.tipo === "proposta" ? undefined : args.tipo),
          pedido: userText,
          policy: state.policy,
          agora: Date.now(),
        },
        depsDoFluxo(state, extra)
      );
      // Pedido de criação que cita proposta existente: o modelo quis um formulário
      // a partir dela, então é conversão. Continua a proposta em vez de recusar.
      if (passo.evento === "criacao_referencia_existente" && podeEscrever(state.identity)) {
        passo = await iniciarContinuidade({ texto: userText, messageId: state.inbound.messageId, policy: state.policy,
          politicaIndisponivel: state.politicaIndisponivel, agora: Date.now() }, depsDoFluxo(state, extra), { converter: true });
      }

      return {
        ...daOferta,
        pendingAction: null,
        fluxo: passo.fluxo,
        messages: [
          { role: "user", content: userText },
          { role: "assistant", content: passo.reply },
        ],
        reply: passo.reply,
        usage: [...usageDoTurn, ...extra],
        toolLog: [
          ...trilha,
          { name: chamada.name, args: { tipo: args.tipo }, outcome: passo.evento },
        ],
      };
    }

    /**
     * Recusada. `tipo_invalido` é o caso antigo: o nano inventou um valor
     * ("aluguel", "form") e escolher o mais parecido criaria a coisa errada
     * com a confirmação da pessoa em cima — cai no caminho de texto e ela
     * repete o pedido.
     */
    if (auth.motivo === "tipo_invalido") {
      console.warn(`[answer] tipo inválido na chamada: ${JSON.stringify(chamada.args)}`);
    }
    trilha.push({ name: chamada.name, args: chamada.args, outcome: auth.motivo });

    // Política que não concede ESTE tipo (ex.: `form.create` sim,
    // `proposal.create` não): resposta de template, que diz que nada foi
    // criado. Deixar o modelo improvisar aqui era convite a "pronto, criei".
    const args = argsDaCriacao(chamada.args, displayName(state.identity));
    if (auth.motivo === "capability_negada" && args) {
      const texto = textoSemPermissao(args);
      return {
        ...daOferta,
        messages: [
          { role: "user", content: userText },
          { role: "assistant", content: texto },
        ],
        reply: texto,
        usage: usageDoTurn,
        toolLog: trilha,
      };
    }
  }

  /**
   * O modelo pediu LEITURA. Não respondemos ainda — o laço executa e volta.
   *
   * Sem `draft` aqui de propósito: o que ele escreveu junto de uma chamada de
   * ferramenta é preâmbulo ("deixa eu ver..."), não resposta, e mandá-lo para
   * o `compose` faria a pessoa receber duas mensagens por turn.
   */
  const deLeitura = result.toolCalls.filter(
    (c) => buscarNoRegistro(c.name)?.tipo === "leitura"
  );
  if (deLeitura.length > 0) {
    return {
      ...daOferta,
      messages: [{ role: "user", content: userText }],
      pendingToolCalls: deLeitura,
      usage: usageDoTurn,
      ...(trilha.length > 0 ? { toolLog: trilha } : {}),
    };
  }

  /**
   * Texto livre do modelo. Vai para `draft`, **não** para `reply`.
   *
   * E o turno do assistente NÃO é acrescentado aqui: quem acrescenta é o
   * `compose`, com o texto já sanitizado. Gravar o cru no histórico deixaria o
   * encanamento no contexto do turno seguinte — o modelo leria o próprio JSON
   * vazado como exemplo do que fazer.
   */
  return {
    ...daOferta,
    messages: [{ role: "user", content: userText }],
    draft: result.text,
    usage: usageDoTurn,
    // Mesma proteção do `usage` acima: `trilha` é `[]` quando não houve
    // chamada, e `[]` é o sinal de reset do reducer. Hoje seria inofensivo
    // porque `confirm` e `answer` nunca rodam no mesmo turn — mas isso é
    // invariante de topologia, não garantia estrutural, e no dia em que
    // alguém quebrar a topologia este `[]` apagaria em silêncio o que o
    // `confirm` acabou de gravar.
    ...(trilha.length > 0 ? { toolLog: trilha } : {}),
  };
}

/**
 * Executa as tools de LEITURA que o modelo pediu.
 *
 * ── Por que este nó existe, em vez de chamar dentro do `answer` ───────────
 *
 * O laço. `answer → tools → answer` é o que permite o modelo pedir, ver o
 * resultado e então responder. Fazer a chamada dentro do `answer` daria uma
 * volta só, e o caso comum ("meus negócios" → lista → "e o do Silva?") precisa
 * de duas.
 *
 * ── ⚠️ O que este nó NUNCA pode espalhar ──────────────────────────────────
 *
 * `usage: []` e `toolLog: []`. Os reducers dos dois tratam **lista vazia como
 * RESET**, não como "nada a acrescentar" — é como o `runTurn` os zera na
 * entrada. Num laço de até três voltas, uma rodada que espalhasse `[]` apagaria
 * o custo do turno inteiro: sem erro, sem teste vermelho, e sumindo exatamente
 * no painel de custo. Viola a regra 6 da governança ("operação nova sem linha
 * de custo é bug"). Por isso tudo aqui é espalhado condicionalmente.
 *
 * Este nó **não chama modelo**, então não produz `usage` — e é justamente por
 * isso que ele não pode tocar no campo.
 */
async function tools(state: MaxStateType): Promise<Partial<MaxStateType>> {
  const chamadas = state.pendingToolCalls;
  if (chamadas.length === 0) return { pendingToolCalls: [] };

  /**
   * ⚠️ **A capability é reconferida na EXECUÇÃO, não só na oferta** — agora
   * dentro do despachante, junto das outras travas.
   *
   * A oferta gateia o que o modelo VÊ; o despachante gateia o que ele
   * CONSEGUE. O modelo pode emitir uma chamada com o nome de qualquer tool do
   * catálogo — por alucinação, ou porque uma instrução injetada num resultado
   * anterior mandou (a própria cerca `fenceToolResults` nomeia essa
   * superfície). Mesma classe do `descartarSeVazou`, uma camada acima: lá o
   * campo, aqui o verbo.
   */
  const { resultados, trilha, referencias } = await despacharLeituras({
    chamadas,
    oferecidas: state.toolsOferecidas,
    policy: state.policy,
    identity: state.identity,
    fromPhone: state.inbound.fromPhone,
    referencias: state.referencias,
    turno: state.inbound.messageId,
  });

  return {
    pendingToolCalls: [],
    toolRounds: state.toolRounds + 1,
    // Só quando mudou: uma volta sem lista não pode apagar a numeração que a
    // pessoa acabou de ler.
    ...(referencias !== state.referencias ? { referencias } : {}),
    // Condicional: ver o aviso do cabeçalho. `resultados` é vazio quando toda
    // chamada tinha nome inventado.
    ...(resultados.length > 0 ? { toolResults: resultados } : {}),
    ...(trilha.length > 0 ? { toolLog: trilha } : {}),
  };
}

/**
 * Volta para o `tools` ou segue para o `compose`.
 *
 * `TOOL_MAX_ROUNDS = 3`, e não "até o modelo parar". O turn inteiro vive numa
 * function de 60 s que já gastou identidade, transcrição e RAG; cada volta é
 * uma chamada de modelo mais uma de rede. E um nano em laço não converge.
 *
 * Estourar o teto **não é erro**: o `answer` responde com o que já coletou.
 */
function afterAnswer(state: MaxStateType): "tools" | "compose" {
  if (state.pendingToolCalls.length === 0) return "compose";
  if (state.toolRounds >= TOOL_MAX_ROUNDS) {
    console.info(
      `[tools] rounds_exhausted em ${state.identity.orgId} — respondendo com o que há`
    );
    return "compose";
  }
  return "tools";
}

/**
 * O ÚNICO ponto por onde a resposta sai.
 *
 * Hoje faz uma coisa só — sanitizar o texto do modelo —, e mesmo assim é um nó
 * em vez de duas linhas dentro do `answer`. A razão é o que vem depois: o áudio
 * (PR 10) precisa vocalizar **a string final**, não uma segunda geração, e o
 * `<dados_do_sistema>` (PR 6) traz mais uma fonte de texto para o mesmo funil.
 * Três lugares que compõem a resposta viram três lugares que esquecem coisas
 * diferentes; um lugar só é o desenho.
 *
 * Passagem franca quando não há `draft`: os caminhos de template (confirmação,
 * kill switch, deny-list, falha do modelo) já produziram a resposta final e
 * atravessam sem serem tocados — o link de formulário sai byte a byte como o
 * template escreveu.
 */
async function compose(state: MaxStateType): Promise<MaxUpdate> {
  if (state.draft === null) return {};

  const { texto, bloqueios } = sanitizar(state.draft);

  if (bloqueios.length > 0) {
    // Nível de aviso e não de erro: o turno saiu, e o que se quer é o padrão
    // aparecendo no log para alguém correlacionar com a linha da auditoria.
    console.warn(
      `[compose] saída sanitizada (${bloqueios.join(",")}) em ${state.identity.orgId}`
    );
  }

  // Antes do teto: afirmação de criação no texto livre é falsa por construção
  // (escrita real sai por template) — ver `travarCriacaoFalsa`.
  const trava = travarCriacaoFalsa(texto, {
    houveLeitura: state.toolResults.some((r) => r.items !== null),
    podeCriar: modoDeCriacao(state.identity, state.policy) === "disponivel",
    podeEnviar: podeEscrever(state.identity) && state.policy.includes("proposal.send"),
  });
  if (trava.travou) {
    console.warn(`[compose] afirmação de criação/envio sem escrita em ${state.identity.orgId}`);
  }

  // G6: o teto vale DEPOIS do sanitizador — cortar antes contaria linha que
  // ia cair de qualquer jeito. O resto fica guardado para o "quer ver?".
  const final = limitarTamanho(trava.texto);

  return {
    reply: final.texto,
    restoDaResposta: final.resto ? { texto: final.resto, criadoEm: Date.now() } : null,
    // Consumido: se sobrasse no checkpoint, o turno seguinte que respondesse
    // por template encontraria um `draft` velho e o `compose` publicaria a
    // resposta do turno passado por cima.
    draft: null,
    bloqueios,
    messages: [{ role: "assistant", content: final.texto }],
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
        "pendente. Não invente nada que não esteja no texto. Não copie CPF, " +
        "telefone, e-mail nem número de documento.",
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
    return {
      summary: result.text,
      messages: { replace: keep },
      usage: [result.usage],
    };
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

/**
 * `halt` corta o turn, mas a resposta ainda tem que SAIR — e sair pelo mesmo
 * lugar que todas as outras.
 *
 * Antes ia direto pro END. Passa pelo `compose` porque é lá que a mensagem vai
 * ser montada quando houver áudio e segunda linha de outbox: um caminho que
 * escapasse dessa montagem entregaria o kill switch por um formato e o resto
 * por outro.
 */
function afterGate(state: MaxStateType): "continuar" | "compose" {
  return state.halt ? "compose" : "continuar";
}

/** O `continuar` mandou o resto? Então o turn está resolvido. */
function afterContinuar(state: MaxStateType): "conduzir" | "compose" {
  return state.reply ? "compose" : "conduzir";
}

/** O fluxo de criação respondeu? Então o turn está resolvido. */
function afterConduzir(state: MaxStateType): "confirm" | "compose" {
  return state.reply ? "compose" : "confirm";
}

/**
 * O `confirm` já respondeu?
 *
 * Ele responde quando executou, cancelou ou falhou — nos três casos o turn está
 * resolvido e passar pelo modelo seria pagar por uma resposta que já existe.
 * Vai pro `compose`, e de lá pro `compact`, que ainda precisa rodar: o `confirm`
 * acrescentou turnos ao histórico como qualquer outro nó.
 */
function afterConfirm(state: MaxStateType): "retrieve" | "compose" {
  return state.reply ? "compose" : "retrieve";
}

/**
 * Turn interrompido não compacta.
 *
 * `halt` é kill switch ou deny-list: dois caminhos cujo valor é custar ZERO
 * token. Deixar o `compact` rodar depois deles gastaria uma chamada de modelo
 * numa thread comprida — justamente no turno que existe para não gastar
 * nenhuma.
 */
function afterCompose(state: MaxStateType): "compact" | typeof END {
  return state.halt ? END : "compact";
}

/** Um nó do grafo, com o tempo que levou anexado ao estado (`timings`). */
export interface TimingDeNo {
  no: string;
  ms: number;
}

/**
 * Envolve um nó para medir o que ELE levou — sem contar o checkpoint, que o
 * LangGraph grava entre nós. Soma com `latency_ms` do turn, não substitui: a
 * diferença entre os dois é justamente o custo do checkpointer e da fila.
 *
 * A medição vai junto da atualização que o nó devolve, então um nó que falha
 * não registra tempo — o turn inteiro já conta como erro.
 */
function cronometrar(
  no: string,
  fn: (state: MaxStateType) => Promise<MaxUpdate> | MaxUpdate
): (state: MaxStateType) => Promise<MaxUpdate> {
  return async (state) => {
    const iniciadoEm = Date.now();
    const update = await fn(state);
    return { ...update, timings: [{ no, ms: Date.now() - iniciadoEm }] };
  };
}

export function buildGraph() {
  return new StateGraph(MaxState)
    .addNode("gate", cronometrar("gate", gate))
    .addNode("continuar", cronometrar("continuar", continuar))
    .addNode("conduzir", cronometrar("conduzir", conduzir))
    .addNode("confirm", cronometrar("confirm", confirm))
    .addNode("retrieve", cronometrar("retrieve", retrieve))
    .addNode("answer", cronometrar("answer", answer))
    .addNode("tools", cronometrar("tools", tools))
    .addNode("compose", cronometrar("compose", compose))
    .addNode("compact", cronometrar("compact", compact))
    .addEdge(START, "gate")
    .addConditionalEdges("gate", afterGate, {
      continuar: "continuar",
      compose: "compose",
    })
    .addConditionalEdges("continuar", afterContinuar, {
      conduzir: "conduzir",
      compose: "compose",
    })
    .addConditionalEdges("conduzir", afterConduzir, {
      confirm: "confirm",
      compose: "compose",
    })
    .addConditionalEdges("confirm", afterConfirm, {
      retrieve: "retrieve",
      compose: "compose",
    })
    .addEdge("retrieve", "answer")
    // O laço: `answer` pede, `tools` executa, `answer` responde. Fecha em
    // `compose` quando não há chamada pendente ou o teto de voltas estourou.
    .addConditionalEdges("answer", afterAnswer, {
      tools: "tools",
      compose: "compose",
    })
    .addEdge("tools", "answer")
    .addConditionalEdges("compose", afterCompose, {
      compact: "compact",
      [END]: END,
    })
    .addEdge("compact", END);
}

let checkpointer: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    // Pool própria COM teto (ver `checkpointerPool` em db.ts): o saver segura
    // um client em transação por escrita — na pool compartilhada ele
    // estrangulava as queries da fila; via `fromConnString` era uma pool sem
    // teto furando a contabilidade do Neon.
    const saver = new PostgresSaver(checkpointerPool());
    // `setup()` é DDL idempotente, mas rodar a cada cold start é uma rodada de
    // CREATE IF NOT EXISTS por instância. Depois do primeiro deploy com as
    // tabelas criadas, desligue com MAX_CHECKPOINTER_SETUP=0.
    if (process.env.MAX_CHECKPOINTER_SETUP !== "0") {
      await saver.setup();
    }
    // Só vira singleton DEPOIS do setup: um saver cujo DDL falhou não pode
    // ficar cacheado, senão a instância inteira fica presa a ele até o próximo
    // cold start (é o que o `getApp` promete ao não cachear falha).
    checkpointer = saver;
  }
  return checkpointer;
}

type AppCompilado = ReturnType<ReturnType<typeof buildGraph>["compile"]>;
let appCompilado: Promise<AppCompilado> | null = null;

/**
 * O grafo compilado, UMA vez por instância.
 *
 * Até aqui cada chamada (`runTurn`, `seedNotification`, `descartarPendencias`)
 * montava e compilava o grafo de novo — trabalho puro de CPU repetido em todo
 * turn, e três lugares para esquecer o checkpointer. A compilação é
 * determinística e sem estado; o que varia por chamada é o `thread_id`, que
 * vai no `config`.
 *
 * Falha na compilação (ou no `setup()` do checkpointer) NÃO fica cacheada: a
 * próxima chamada tenta de novo.
 */
export function getApp(): Promise<AppCompilado> {
  if (!appCompilado) {
    appCompilado = (async () =>
      buildGraph().compile({ checkpointer: await getCheckpointer() }))().catch((err) => {
      appCompilado = null;
      throw err;
    });
  }
  return appCompilado;
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
   * Trabalho que só pode acontecer DEPOIS de a resposta sair: o registro de
   * auditoria (`conversation_turn`) e a extração de memória.
   *
   * É um thunk e não uma chamada direta de propósito: a promessa "fora do
   * caminho crítico" vira estrutura em vez de comentário. Quem chama não
   * consegue rodar isto antes de enviar sem escrever a linha errada de
   * propósito. Nunca lança.
   *
   * Deixou de ser opcional quando a auditoria entrou: ANTES ele só existia
   * quando havia o que aprender, e um turn sem resposta — justamente o que
   * alguém iria investigar — não deixava rastro nenhum.
   */
  afterReply: () => Promise<void>;
}

/**
 * O que é zerado a CADA turn — o contrato que o checkpointer obriga a manter.
 *
 * Constante nomeada, e não literal dentro do `invoke`, por um motivo concreto:
 * campo de estado novo que seja do TURN precisa entrar aqui, e um literal
 * enterrado numa chamada não convida ninguém a lembrar disso. O PR 6a
 * acrescentou três campos e esqueceu — o resultado foi a tool nunca mais ser
 * oferecida depois do primeiro uso na conversa, e o dado do primeiro turn
 * reaparecer em todo prompt seguinte. Nenhum teste pegou, porque o defeito só
 * existe ATRAVÉS de turns.
 *
 * **Só `messages`, `summary`, `pendingAction`, `referencias` (G2, com TTL
 * próprio), `fluxo` (criação em andamento, TTL de inatividade) e
 * `restoDaResposta` (G6, um turn) atravessam turns de propósito.**
 * Qualquer outro campo de `MaxState` pertence aqui.
 */
export const RESET_DO_TURN = {
    reply: null,
    halt: null,
    propostaDescartada: false,
    // `draft` restaurado seria o pior dos dois: o `compose` publicaria a
    // resposta do turno PASSADO por cima de uma resposta de template deste.
    draft: null,
    bloqueios: [],
    // Zerados como `reply`, e pelo mesmo motivo: o checkpointer restaura o
    // estado inteiro, então sem isto o consumo e a trilha do turn passado
    // voltariam somados ao deste. Lista vazia é o sinal de reset (ver o
    // reducer).
    usage: [],
    toolLog: [],
    /**
     * O laço de tools é DO TURN, e o checkpointer restaura o estado inteiro.
     *
     * Sem estes três, o defeito é duplo e silencioso, e foi reproduzido em
     * dois turns na mesma thread:
     *  - `toolRounds` nunca voltava a 0, e a seleção só roda em
     *    `toolRounds === 0` — então a tool de leitura **nunca mais era
     *    oferecida** naquela conversa, depois do primeiro uso. Regressão
     *    permanente da própria feature deste PR.
     *  - `toolResults` seguia injetando o resultado do primeiro turn em TODO
     *    prompt seguinte, apresentando dado de negócio velho como atual.
     */
    pendingToolCalls: [],
    toolRounds: 0,
    toolResults: [],
    // A oferta é do turn: herdada, deixaria o despachante aceitar chamada de
    // uma tool que este turn nem mostrou ao modelo.
    toolsOferecidas: [],
    timings: [],
    politicaIndisponivel: false,
};

export async function runTurn(inbound: InboundMessage): Promise<TurnResult> {
  // Latência do TURN, não do modelo: inclui identidade, transcrição, RAG e
  // checkpoint. É esse número que a pessoa sente, e é o que o painel mostra.
  const iniciadoEm = Date.now();
  const texto = inbound.text?.trim() ?? "";

  /**
   * Saída antecipada COM rastro.
   *
   * Os caminhos que não chegam ao grafo — número desconhecido, telefone em
   * duas imobiliárias, mídia que não transcreveu — eram justamente os que não
   * deixavam registro nenhum, e são os que alguém investiga primeiro quando
   * pergunta "por que fulano não foi atendido?". `orgId` é opcional porque
   * nesses casos ele pode nem existir ainda.
   */
  const sair = (
    reply: string | null,
    extra: { orgId?: string; error?: string } = {}
  ): TurnResult => ({
    reply,
    afterReply: async () => {
      await registrarTurn({
        orgId: extra.orgId ?? SEM_ORG,
        phone: inbound.fromPhone,
        messageId: inbound.messageId,
        kind: inbound.kind,
        inboundText: texto || null,
        replyText: reply,
        latencyMs: Date.now() - iniciadoEm,
        error: extra.error ?? null,
      });
    },
  });
  /**
   * Falha AQUI também precisa deixar rastro.
   *
   * `resolveIdentity` e o `invoke` do grafo são os dois pontos que podem
   * lançar sem passar por nenhum `sair()` nem pelo `afterReply` — instabilidade
   * do Postgres, falha do checkpointer ao persistir. Sem isto, esse turn não
   * gera linha nenhuma em `conversation_turn`, e a falha mais provável de se
   * repetir some justamente da ferramenta construída para investigá-la. O
   * `runQueued` ainda marca `inbound_queue.last_error`, mas quem abre o painel
   * de conversa não vê nada.
   *
   * Registra e RE-LANÇA: o turn continua falhando, e a fila continua tratando
   * a falha como sempre tratou.
   */
  const comRastro = async <T>(fn: () => Promise<T>, orgId?: string): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      await registrarTurn({
        orgId: orgId ?? SEM_ORG,
        phone: inbound.fromPhone,
        messageId: inbound.messageId,
        kind: inbound.kind,
        inboundText: texto || null,
        latencyMs: Date.now() - iniciadoEm,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  /**
   * Resposta a template que pede resposta (OK da mensagem da imobiliária,
   * "Tenho uma dúvida" do lembrete de configuração) — ANTES da identidade: a
   * parte do negócio é desconhecida para o Max e é quem mais recebe a
   * mensagem da imobiliária. Sem modelo. Ver `lib/aceite.ts`.
   */
  const aceite = await comRastro(() => interceptar(inbound));
  if (aceite) {
    return sair(aceite.reply, { orgId: aceite.orgId ?? undefined, error: aceite.marca });
  }

  const identity = await comRastro(() => resolveIdentity(inbound.fromPhone));

  // Desconhecido não abre thread nem gasta modelo. Pode ser cliente que
  // respondeu a um aviso, engano ou spam.
  if (identity.kind === "unknown") {
    // Uma apresentação por ciclo do cache negativo, e depois silêncio:
    // responder cada mensagem de um número estranho consome cota da Z-API e
    // confirma ao spammer que o número é vivo.
    if (identity.alreadyGreeted) {
      // Insistiu: a primeira insistência do dia vai para a equipe (decisão de
      // 05/10/2026); o resto segue em silêncio. Falha no repasse = silêncio,
      // como antes — nunca derruba o turno.
      const repasse = await repassarDesconhecido(inbound).catch((err) => {
        console.warn(
          "[graph] repasse do desconhecido falhou:",
          err instanceof Error ? err.message : String(err)
        );
        return null;
      });
      if (repasse) return sair(repasse.reply, { orgId: SEM_ORG, error: repasse.marca });
      return sair(null, { error: "desconhecido_silenciado" });
    }
    // Falhar em marcar só significa reapresentar na próxima — nunca vale
    // derrubar a resposta por isso.
    await markGreeted(inbound.fromPhone).catch(() => undefined);
    return sair(
      "Oi! Sou o Max, assistente das imobiliárias parceiras. Não reconheci " +
        "este número — fale com seu corretor para liberar o acesso.",
      { error: "desconhecido_apresentado" }
    );
  }

  // Primeira vez com o telefone em mais de uma imobiliária: pergunta e para.
  if (identity.kind === "ambiguous") {
    return sair(askWhichOrg(identity.candidates), { error: "ambiguo" });
  }

  // Já perguntamos: esta mensagem PODE ser a resposta.
  if (identity.kind === "pending") {
    // Mídia aqui não dá pra transcrever: a transcrição precisa do token de UMA
    // org, e é justamente a org que ainda não sabemos. Mandar o áudio pra
    // primeira candidata entregaria o conteúdo de alguém a uma imobiliária que
    // pode não ser a dele.
    if (!texto && inbound.kind !== "text") {
      return sair(
        "Antes de continuar preciso saber de qual imobiliária você fala. " +
          "Responde por escrito, por favor:\n\n" +
          askWhichOrg(identity.candidates),
        { error: "ambiguo_com_midia" }
      );
    }
    const escolhido = matchChoice(texto, identity.candidates);
    if (!escolhido) {
      // Não insistir com o texto igual seria pior — repetir a lista deixa claro
      // que o Max ainda está esperando, em vez de parecer que ignorou.
      return sair(askWhichOrg(identity.candidates), { error: "escolha_nao_casou" });
    }
    await saveChoice(inbound.fromPhone, escolhido.orgId);
    return sair(
      `Certo, ${escolhido.orgName}. Pode mandar sua pergunta que eu respondo ` +
        "com o material dessa imobiliária.",
      { orgId: escolhido.orgId }
    );
  }

  /**
   * Áudio vira texto ANTES do grafo.
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

  /**
   * G5 — imagem e documento NÃO são lidos (sem OCR, sem transporte de
   * documento; plano de 05/10). Até aqui a imagem era descrita pelo Gemini e
   * virava texto: além do custo, era o Max "lendo" matrícula, RG e
   * comprovante que deveriam entrar pelo sistema, com trilha e dono. Agora:
   * frase fixa apontando o ImobPro, sem LLM e sem download.
   *
   * Com legenda, a LEGENDA é a mensagem (como sempre foi) — a mídia continua
   * não lida, e o prompt diz ao modelo que ele não lê anexo.
   */
  if (!turnText && (inbound.kind === "image" || inbound.kind === "document")) {
    await descartarPendencias(identity.candidate.orgId, inbound.fromPhone);
    return sair(textoSemLeituraDeMidia(null), {
      orgId: identity.candidate.orgId,
      error: `sem_texto_${inbound.kind}`,
    });
  }

  // O que o parse não reconheceu: silêncio é pior, e passar pelo modelo com
  // "(mensagem sem texto)" pagava um turn por uma resposta genérica.
  if (!turnText && inbound.kind === "unknown") {
    await descartarPendencias(identity.candidate.orgId, inbound.fromPhone);
    return sair(
      "Não consegui entender esse tipo de mensagem. Pode mandar por escrito?",
      { orgId: identity.candidate.orgId, error: `sem_texto_${inbound.kind}` }
    );
  }

  if (!turnText && inbound.kind === "audio") {
    fromMedia = "audio";
    const transcrito = inbound.mediaUrl
      ? await transcreverMidia(identity.candidate.orgId, inbound)
      : null;

    if (!transcrito) {
      // A pessoa pode ter dito "sim" NESTE áudio — e não ouvimos. A pendência
      // não pode sobreviver a um turn que não a confirmou (D3).
      await descartarPendencias(identity.candidate.orgId, inbound.fromPhone);
      // Dizer que não deu, sempre. Silêncio faria a pessoa esperar resposta de
      // uma coisa que o agente nunca recebeu — e no WhatsApp ela não tem como
      // saber a diferença entre "ignorou" e "não chegou".
      return sair("Não consegui ouvir esse áudio. Pode me mandar por escrito?", {
        orgId: identity.candidate.orgId,
        error: `transcricao_falhou_${fromMedia}`,
      });
    }
    turnText = transcrito;
  }

  const orgId = identity.candidate.orgId;
  const phone = inbound.fromPhone;

  // Carregado ANTES do grafo, junto com o resto do que o prompt precisa. É
  // uma query indexada pela PK — mais barata que a busca semântica que o mesmo
  // turn já faz. Em paralelo com o grafo (que só compila na primeira vez).
  const [facts, app] = await Promise.all([loadFacts(orgId, phone), getApp()]);

  const result = await comRastro(() => app.invoke(
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
       * O que atravessa turns de propósito está listado no `RESET_DO_TURN`.
       */
      ...RESET_DO_TURN,
    },
    {
      configurable: {
        thread_id: threadIdFor(orgId, phone),
      },
    }
  ), orgId);

  const reply = result.reply ?? null;
  const usage = result.usage ?? [];
  const tools = result.toolLog ?? [];
  const timings = result.timings ?? [];
  const latencyMs = Date.now() - iniciadoEm;

  /**
   * O DESFECHO do turn, na mesma coluna que os desfechos das saídas
   * antecipadas (`sair()` já grava "ambiguo", "desconhecido_silenciado" e
   * afins ali). `error` nesta tabela sempre significou "por que este turn não
   * foi um turn normal", não "houve exceção".
   *
   * Os dois casos que passam a aparecer nunca coexistem: `halt` corta antes do
   * `answer`, então não há `draft` para sanitizar quando ele está setado. E os
   * dois eram invisíveis até agora — inclusive o kill switch, que desligava o
   * agente sem deixar rastro nenhum na auditoria de conversa.
   */
  const desfecho =
    result.halt ??
    (result.bloqueios?.length
      ? `sanitizado:${result.bloqueios.join(",")}`
      : null);

  return {
    reply,
    // Só vale extrair de um turn que teve as duas pontas: sem resposta não há
    // conversa da qual aprender, e um turn que falhou no modelo ensinaria o
    // erro.
    /**
     * Auditoria + memória, nesta ordem e as duas fora do caminho crítico.
     *
     * O registro vem PRIMEIRO porque é o que permite investigar quando a
     * extração falha — se a memória lançasse antes, o turn ficaria sem
     * rastro justamente no caso em que alguém iria procurá-lo. `registrarTurn`
     * nunca lança, então não há risco de inverter o problema.
     */
    afterReply: async () => {
      await registrarTurn({
        orgId,
        phone,
        messageId: inbound.messageId,
        kind: inbound.kind,
        inboundText: turnText || null,
        // Só quando houve mídia: repetir o texto digitado nas duas colunas
        // encheria a tabela sem acrescentar informação.
        transcript: fromMedia ? turnText : null,
        replyText: reply,
        tools,
        usage,
        timings,
        latencyMs,
        error: desfecho,
      });

      /**
       * Turn interrompido não alimenta a memória — e `halt` aqui vale por
       * DINHEIRO, não só por higiene.
       *
       * `extractFacts` é uma chamada de modelo. Sem este corte, a promessa de
       * que a deny-list "custa zero" seria falsa por um caminho fora do grafo:
       * o `answer` não roda, mas a extração roda logo depois, e sondar o Max
       * passaria a gastar token — justamente o que a recusa determinística
       * existe para impedir.
       *
       * O kill switch tinha o mesmo furo desde sempre, e mais grave: um agente
       * DESLIGADO gastava modelo aprendendo sobre a pessoa. E o que se
       * aprenderia dos dois é lixo — "esta pessoa perguntou pelo prompt do
       * sistema" não é fato durável sobre ninguém.
       */
      if (!(reply && turnText) || result.halt) return;
      await (async () => {
            const novos = await extractFacts({
              orgId,
              phone,
              userText: turnText,
              replyText: reply,
              known: facts,
            });
            const gravados = await saveFacts(orgId, phone, novos);
            if (gravados > 0) {
              console.log(`[memory] ${gravados} fato(s) de ${phoneTag(phone)} em ${orgId}`);
            }
      })();
    },
  };
}

/**
 * D3 — saída antecipada também é um TURN, e "a pendência sobrevive no máximo
 * um turn" vale para ela.
 *
 * As saídas por mídia (`sair()`) não passam pelo grafo, então nem o `confirm`
 * nem o `continuar` rodam e a pendência atravessava intacta: "Crio o
 * formulário?" → foto → "sim" horas depois (dentro do TTL) criava. Limpa as
 * duas coisas que atravessam turns por UM turn: a pendência de escrita e o
 * resto da resposta. As referências numeradas (G2) ficam: têm TTL próprio e
 * não executam nada sozinhas.
 *
 * Falha aqui NÃO derruba a resposta (o turn já tem texto pronto), mas é erro,
 * não aviso: a pendência sobreviveu, e quem lê o log precisa saber disso. O
 * TTL de 30 min continua sendo o teto.
 */
async function descartarPendencias(orgId: string, phone: string): Promise<void> {
  try {
    const app = await getApp();
    const config = { configurable: { thread_id: threadIdFor(orgId, phone) } };
    const atual = await app.getState(config);
    const v = atual.values as Partial<MaxStateType> | undefined;
    // Thread sem nada a descartar não ganha checkpoint novo à toa.
    const fluxoRebaixado = rebaixarFluxo(v?.fluxo);
    const fluxoMudou = JSON.stringify(fluxoRebaixado ?? null) !== JSON.stringify(v?.fluxo ?? null);
    if (!v?.pendingAction && !v?.restoDaResposta && !fluxoMudou) return;
    await app.updateState(config, {
      pendingAction: null,
      restoDaResposta: null,
      // O fluxo fica, mas fora de qualquer etapa em que o próximo "sim" escreve.
      ...(fluxoMudou ? { fluxo: fluxoRebaixado } : {}),
    });
  } catch (err) {
    console.error(
      "[graph] não consegui descartar a pendência na saída antecipada:",
      err instanceof Error ? err.message : String(err)
    );
  }
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
