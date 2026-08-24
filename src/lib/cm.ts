import { orgById } from "./orgs";
import { normalizeBrPhone } from "./phone";
import type { MaxPolicy } from "@/graph/policy";
import { query } from "./db";
import { sign } from "./hmac";
import {
  fetchWithTimeout,
  imobproBase,
  IMOBPRO_TIMEOUT_MS,
  IMOBPRO_ALERT_TIMEOUT_MS,
  IMOBPRO_TRANSCRIBE_TIMEOUT_MS,
} from "./http";

/**
 * Cliente das APIs do ImobPro.
 *
 * Todo dado de tenant entra por aqui, via Bearer — este serviço não tem
 * credencial do Postgres da aplicação, de propósito. Se o Max for
 * comprometido, o atacante herda o que os escopos do token permitem, não o
 * banco inteiro.
 */

const BASE = imobproBase;

async function get<T>(path: string, token: string): Promise<T | null> {
  const res = await fetchWithTimeout(
    `${BASE()}${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
    IMOBPRO_TIMEOUT_MS
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`ImobPro ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * `identifyByPhone` saiu daqui para `lib/identity.ts` quando a resolução deixou
 * de poder devolver UMA org: o mesmo telefone pode estar em duas imobiliárias, e
 * a versão antiga parava no primeiro acerto — o desempate saía da ordem de
 * cadastro. Ver `resolveIdentity`.
 */

export interface AgentProfile {
  enabled: boolean;
  model: string;
  /**
   * Política de capabilities do tenant (`MaxCapabilityPolicy` no ImobPro).
   *
   * **Opcional de propósito**, e é a regra 2 da governança em forma de tipo: o
   * receptor entra antes do emissor, então durante a janela entre os dois
   * deploys esta chave simplesmente não vem. Declará-la obrigatória
   * transformaria "o outro lado ainda não subiu" em erro de turn.
   *
   * Ausente resolve para NENHUMA capability (fail-closed, regra 3) — e é por
   * isso que nada neste repo filtra tool por política ainda: nesta janela,
   * filtrar seria desligar a única capability viva. Ver `graph/policy.ts`.
   */
  maxPolicy?: MaxPolicy | null;
}

/**
 * `instructions` saiu daqui de propósito, e a rota continua devolvendo o campo.
 *
 * O prompt do Max é GLOBAL da plataforma (decisão 1 do PRD do copiloto), então
 * a interface para de declarar o que este runtime não deve consumir. Tirar do
 * TIPO, e não só do call-site, é o que impede a próxima sessão de reintroduzir
 * a leitura sem perceber que está desfazendo uma decisão: `profile.instructions`
 * passa a não compilar.
 *
 * `model` continua declarado mesmo sendo ignorado hoje (carrega id Anthropic e
 * este runtime fala com o OpenRouter) porque o PR 7 volta a lê-lo, com a
 * seleção de modelo por configuração.
 */

/**
 * Persona e configuração do Max, versionadas no console do ImobPro.
 *
 * `enabled: false` responde 200 de propósito lá — é kill switch operacional, e
 * quem chama precisa distinguir "desligado" de "não consegui ler".
 */
export async function fetchProfile(orgId: string): Promise<AgentProfile | null> {
  const org = await orgById(orgId);
  if (!org) return null;
  return get<AgentProfile>("/api/agents/profile?agentKey=max", org.apiToken);
}

export interface KnowledgeHit {
  id: string;
  title: string;
  content?: string;
  similarity?: number;
  lowConfidence?: boolean;
}

/** RAG escopado — o `ragScope` do perfil é aplicado do lado do ImobPro. */
export async function searchKnowledge(
  orgId: string,
  query_: string,
  topK = 5
): Promise<KnowledgeHit[]> {
  const org = await orgById(orgId);
  if (!org) return [];
  const res = await fetchWithTimeout(
    `${BASE()}/api/agents/knowledge/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentKey: "max", query: query_, topK }),
    },
    IMOBPRO_TIMEOUT_MS
  ).catch(() => null);
  if (!res) return [];
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: KnowledgeHit[] };
  return data.results ?? [];
}

/**
 * Áudio e imagem → texto, no ImobPro.
 *
 * A transcrição roda LÁ de propósito: aqui exigiria uma `GEMINI_API_KEY` neste
 * projeto — mais um segredo pra girar — e o custo sumiria do painel de AIUsage,
 * que é onde o dono vê quanto a IA gastou no mês dele. Uma hop de rede em troca
 * de observabilidade, teto de custo e um segredo a menos.
 *
 * Mandamos os BYTES, não a URL da Z-API: passar o link faria o ImobPro buscar
 * uma URL escolhida por terceiro, com credencial de tenant. Quem baixa é este
 * serviço, que já fala com a Z-API de qualquer jeito.
 *
 * `null` = não deu. Quem chama TEM que avisar a pessoa — áudio ignorado em
 * silêncio é pior que "não entendi": ela fica esperando resposta de uma coisa
 * que o agente nunca recebeu.
 */
export async function transcribeMedia(
  orgId: string,
  media: { kind: "audio" | "image"; mimeType: string; data: Buffer }
): Promise<string | null> {
  const org = await orgById(orgId);
  if (!org) return null;
  try {
    // Prazo próprio, maior que o padrão: sobe até 3 MB de mídia e espera a
    // transcrição do outro lado.
    const res = await fetchWithTimeout(
      `${BASE()}/api/agents/media/transcribe`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${org.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentKey: "max",
          kind: media.kind,
          mimeType: media.mimeType,
          data: media.data.toString("base64"),
        }),
      },
      IMOBPRO_TRANSCRIBE_TIMEOUT_MS
    );
    // 409 é o idioma da casa para "já tenho este" (ver /notify): desfecho
    // duplicado aceito é sucesso — carimbar evita reportar para sempre.
    if (res.status === 409) return "ok";
    if (!res.ok) {
      console.warn(
        `[cm] transcrição recusada (${res.status}): ${(await res.text()).slice(0, 200)}`
      );
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    console.error(
      "[cm] transcrição falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

export interface FormularioCriado {
  token: string;
  /**
   * URL ABSOLUTA, pronta pra mandar no WhatsApp.
   *
   * O ImobPro devolve caminho (`/f/<token>/<slug>`) porque quem chama de dentro
   * tem `origin`. Aqui não tem, e montar isso no chamador espalharia a base por
   * mais um arquivo — pior, um esquecimento produziria uma mensagem com um link
   * relativo, que no WhatsApp não é link nenhum.
   */
  url: string;
  dealId: string;
}

/**
 * Cria um formulário de venda vazio e devolve o link público.
 *
 * A única ESCRITA que o Max faz. Usa `POST /api/forms`, que já existia e já
 * aceitava Bearer — o que faltava era o token carregar `documents:rw`. Nenhuma
 * rota nova foi criada: uma `/api/agents/forms` teria que duplicar as seis
 * etapas do handler existente, porque lá a lógica é inline e não há helper.
 *
 * `idempotencyKey` é o `messageId` da mensagem em que a pessoa CONFIRMOU, e não
 * um uuid novo. É o que faz a retentativa devolver o MESMO formulário em vez de
 * criar um segundo: o `withIdempotency` do ImobPro guarda a resposta por 24h sob
 * `(userId, key)`. Um uuid gerado aqui seria diferente a cada tentativa e não
 * protegeria de nada.
 *
 * `corretorIds` semeia `dataJson.comissao.comissionados` e
 * `notificationsJson.brokerIds` — é por ele que o corretor entra na comissão e
 * recebe notificação do negócio, já que o `Deal.userId` fica com o usuário de
 * serviço. **São ids de `SplitRecipient`, NÃO de `User`** — o `/api/forms`
 * filtra por `splitRecipient.findMany({id: {in}, orgId})` e descarta o resto em
 * silêncio; mandar um userId aqui não erra, só não semeia nada. Resolver com
 * `brokerRecipientId` antes de chamar.
 *
 * Erro SOBE, ao contrário dos outros clientes deste arquivo. Perder o relato de
 * custo é aceitável; deixar a pessoa achar que o formulário foi criado não é.
 */
/**
 * O `SplitRecipient` do corretor NESTA org, pelo telefone — ou `null`.
 *
 * Existe porque os `corretorIds` do `/api/forms` são ids de `SplitRecipient`, e
 * a identidade do Max só carrega `userId`. O vínculo entre os dois é o telefone,
 * e quem resolve isso é o `broker-scope` — a mesma rota que a identidade já usa,
 * com as mesmas travas (org do token, `maxEnabled`, 404 pra tudo que não
 * resolve).
 *
 * `null` é resultado NORMAL, não falha: gerente pede formulário sem ser
 * comissionado, e o form nasce sem seed. Por isso nenhum erro sobe daqui.
 */
export async function brokerRecipientId(
  orgId: string,
  rawPhone: string
): Promise<string | null> {
  const org = await orgById(orgId);
  if (!org) return null;
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return null;
  try {
    const res = await fetchWithTimeout(
      `${BASE()}/api/agents/broker-scope?phone=${encodeURIComponent(e164)}`,
      { headers: { Authorization: `Bearer ${org.apiToken}` } },
      IMOBPRO_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const r = (await res.json()) as { splitRecipientId?: string };
    return typeof r.splitRecipientId === "string" ? r.splitRecipientId : null;
  } catch {
    return null;
  }
}

export async function criarFormularioVenda(
  orgId: string,
  params: {
    title?: string;
    corretorIds?: string[];
    idempotencyKey: string;
  }
): Promise<FormularioCriado> {
  const org = await orgById(orgId);
  if (!org) throw new Error(`org ${orgId} não configurada`);

  const res = await fetchWithTimeout(
    `${BASE()}/api/forms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.apiToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        ...(params.title ? { title: params.title } : {}),
        ...(params.corretorIds?.length ? { corretorIds: params.corretorIds } : {}),
      }),
    },
    IMOBPRO_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error(
      `ImobPro /api/forms ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  }

  const data = (await res.json()) as Partial<FormularioCriado>;
  // Sem token não há link, e sem link a resposta seria "criei" sem dizer onde —
  // pior que o erro, porque tem cara de sucesso.
  if (!data.token || !data.dealId) {
    throw new Error("ImobPro /api/forms respondeu sem token/dealId");
  }
  return {
    token: data.token,
    url: `${BASE()}${data.url ?? `/f/${data.token}`}`,
    dealId: data.dealId,
  };
}

/**
 * O tenant não tem o módulo/sub-função ligado.
 *
 * Erro próprio porque o tratamento é outro: não adianta retentar e quem resolve
 * não é quem pediu. Quem chama traduz isso numa frase que diz o que fazer.
 */
export class ModuloDesligadoError extends Error {
  constructor(rota: string) {
    super(`módulo desabilitado para ${rota}`);
    this.name = "ModuloDesligadoError";
  }
}

/** 403 com código de módulo, ou 412 de pipeline não semeado — mesma conclusão. */
function ehModuloDesligado(status: number, corpo: string): boolean {
  if (status === 412) return true; // pipeline de locação não semeado
  return status === 403 && /MODULE_DISABLED|FEATURE_DISABLED|desabilitad/i.test(corpo);
}

/**
 * Formulário de LOCAÇÃO em branco + link.
 *
 * Espelha `criarFormularioVenda`, e as diferenças são todas do outro lado:
 * `POST /api/locacao/forms` exige o escopo `locacao:rw` **e** a permissão
 * `LEASE_CREATE` (o `ensureLocacaoApiAccess` checa as duas), não aceita
 * `corretorIds`, e 412 quando o pipeline de locação não foi semeado na org.
 */
export async function criarFormularioLocacao(
  orgId: string,
  params: {
    title?: string;
    finalidade?: "residencial" | "comercial";
    idempotencyKey: string;
  }
): Promise<FormularioCriado> {
  const org = await orgById(orgId);
  if (!org) throw new Error(`org ${orgId} não configurada`);

  const res = await fetchWithTimeout(
    `${BASE()}/api/locacao/forms`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.apiToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        finalidade: params.finalidade ?? "residencial",
        ...(params.title ? { title: params.title } : {}),
      }),
    },
    IMOBPRO_TIMEOUT_MS
  );

  if (!res.ok) {
    const corpo = await res.text();
    if (ehModuloDesligado(res.status, corpo)) {
      throw new ModuloDesligadoError("/api/locacao/forms");
    }
    throw new Error(
      `ImobPro /api/locacao/forms ${res.status}: ${corpo.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as Partial<FormularioCriado>;
  if (!data.token || !data.dealId) {
    throw new Error("ImobPro /api/locacao/forms respondeu sem token/dealId");
  }
  return {
    token: data.token,
    url: `${BASE()}${data.url ?? `/f/${data.token}`}`,
    dealId: data.dealId,
  };
}

export interface PropostaCriada {
  id: string;
  /** URL absoluta do rascunho no painel — NÃO é link público de aceite. */
  url: string;
}

/**
 * RASCUNHO de proposta + link para completar.
 *
 * Deliberadamente leve, pelo mesmo motivo que o formulário: `POST /api/proposals`
 * exige só `title` e `schemaType`; `dataJson` tem default `{}` e `signers` é
 * opcional. Preencher valor, condição de pagamento e signatários por WhatsApp
 * seria ditar quinze campos num canal onde ninguém relê o que mandou — e um
 * nano transcrevendo número é exatamente onde não se quer economizar.
 *
 * Então o Max abre o rascunho com o nome certo e devolve o link. Quem põe os
 * valores é o corretor, na tela que já existe para isso.
 *
 * A proposta nasce sem `validUntil` de propósito: a rota aplica
 * `defaultValidUntil` (7 dias), e mandar `null` daqui produziria proposta que
 * não expira em lugar nenhum.
 */
export async function criarRascunhoProposta(
  orgId: string,
  params: {
    title: string;
    schemaType: "compra_venda_v1" | "locacao_residencial_v1" | "locacao_comercial_v1";
    idempotencyKey: string;
  }
): Promise<PropostaCriada> {
  const org = await orgById(orgId);
  if (!org) throw new Error(`org ${orgId} não configurada`);

  const res = await fetchWithTimeout(
    `${BASE()}/api/proposals`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.apiToken}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        title: params.title,
        schemaType: params.schemaType,
        dataJson: {},
      }),
    },
    IMOBPRO_TIMEOUT_MS
  );

  if (!res.ok) {
    const corpo = await res.text();
    if (ehModuloDesligado(res.status, corpo)) {
      throw new ModuloDesligadoError("/api/proposals");
    }
    throw new Error(`ImobPro /api/proposals ${res.status}: ${corpo.slice(0, 300)}`);
  }

  const data = (await res.json()) as { proposal?: { id?: string } };
  const id = data.proposal?.id;
  if (!id) throw new Error("ImobPro /api/proposals respondeu sem id");

  // `/pipeline/propostas/[id]/editar`, e não o `/p/[token]` público: o rascunho
  // ainda não tem valores, e mandar o link de aceite agora seria pedir ao
  // cliente que aceitasse o vazio. A tela de edição é onde o corretor completa.
  return { id, url: `${BASE()}/pipeline/propostas/${id}/editar` };
}

/**
 * Reporta o custo do turn. Uma linha POR MODELO: um turn multi-modelo somado
 * num bucket só cobraria Sonnet a preço de Haiku, e esse número alimenta o teto
 * mensal por agente e o painel.
 *
 * ── O que passou a viajar em 22/08 ───────────────────────────────────────
 *
 * `costUsd` e os tokens de cache. Antes o ImobPro só recebia contagem de token
 * e calculava o dólar pela tabela de preços — que é exata quando não há cache
 * (erro de 0,0%, medido) e erra feio quando há: num turn com 1792 de 1956
 * tokens vindos do cache de prefixo, a tabela dizia US$ 0,00042870 contra
 * US$ 0,00010614 reais, **superestimando em 304%**.
 *
 * Do outro lado, `costUsd` SOBREPÕE a estimativa e a linha nasce marcada como
 * `reported`. Isso é exceção declarada à regra de lá ("custo informado por
 * quem gasta não é medição"), e ela se sustenta porque o número não é nosso:
 * vem do `usage.cost` do OpenRouter. Nós só transportamos.
 */
export async function reportUsage(
  orgId: string,
  usage: {
    model: string;
    promptTokens: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** `null` = o provedor não informou. NUNCA 0 — ver `LlmUsage.costUsd`. */
    costUsd?: number | null;
    latencyMs: number;
    success?: boolean;
    dealId?: string | null;
  }
): Promise<void> {
  const org = await orgById(orgId);
  if (!org) return;
  try {
    const res = await fetchWithTimeout(
      `${BASE()}/api/agents/usage`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${org.apiToken}`,
          "Content-Type": "application/json",
        },
        /**
         * Corpo montado campo a campo, e não `...usage`, de propósito: o
         * `LlmUsage` carrega coisas que o contrato NÃO declara (hoje
         * `generationId`, que serve para reconciliar contra o `/v1/generation`
         * do OpenRouter e vive no `conversation_turn` daqui). O zod de lá não
         * é `.strict()`, então um spread mandaria campo desconhecido que é
         * descartado em silêncio — o tipo de descasamento que ninguém vê até
         * precisar dele.
         */
        body: JSON.stringify({
          agentKey: "max",
          provider: "openrouter",
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
          latencyMs: usage.latencyMs,
          success: usage.success,
          dealId: usage.dealId,
        }),
      },
      IMOBPRO_TIMEOUT_MS
    );

    /**
     * O status É lido, e não deveria ter sido opcional.
     *
     * Sem esta checagem, um 400 do zod de lá descartava a linha de custo em
     * SILÊNCIO — o `fetch` resolve normalmente com `ok: false` e o `catch`
     * abaixo nunca via nada. É a mesma classe de falha que o `sendEmail`
     * (`ok:false` sem exceção) e que o "202 não prova gravação": o caminho
     * feliz e o caminho perdido tinham exatamente a mesma aparência.
     *
     * Continua fire-and-forget — não retentamos e não lançamos, porque perder
     * a contabilidade de um turn é menos grave que não responder à pessoa. O
     * que muda é que agora aparece no log, com o motivo.
     */
    if (!res.ok) {
      const corpo = await res.text().catch(() => "");
      console.error(
        `[cm] reportUsage recusado (${res.status}) — linha de custo PERDIDA ` +
          `para ${usage.model}: ${corpo.slice(0, 200)}`
      );
    }
  } catch (err) {
    // Fire-and-forget: perder a contabilidade de um turn é ruim, não responder
    // ao usuário por causa disso é pior.
    console.warn("[cm] reportUsage falhou:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Entrega ao Contractmaker o DESFECHO de uma notificação — o caminho de volta
 * que fecha o ponto cego do 202 (docs/max.md §8 de lá).
 *
 * A costura é a `dedupeKey`: é a mesma chave que veio no `/notify` e que os
 * logs de lá (`DealNotificationLog`/`UserNotificationDelivery`) guardam.
 * Nenhum id nosso viaja — o Max não sabe de qual trilho a notificação nasceu,
 * e não precisa.
 *
 * Assinado com o MESMO formato HMAC do `/notify` (`timestamp.rawBody`, já
 * travado por vetor fixo nos dois repos), mas com um secret PRÓPRIO
 * (`MAX_WEBHOOK_SECRET`): o `MAX_NOTIFY_SECRET` autentica o Contractmaker
 * falando com o Max; este autentica o Max falando com o Contractmaker.
 * Compartilhar o mesmo valor deixaria qualquer um dos lados forjar o outro.
 *
 * O desfecho é TRI-estado, e a diferença importa (achado do orquestrador):
 *
 *  - `"ok"`        → aceito; o chamador carimba `reported_at`.
 *  - `"rejected"`  → o Contractmaker RECUSOU esta linha (4xx de payload) —
 *                    conta tentativa; após o teto, desiste dela.
 *  - `"unavailable"` → a INTEGRAÇÃO está fora (secret ausente, rota ainda não
 *                    deployada = 404, 503, 5xx, rede/timeout). Não é culpa da
 *                    linha, mas **conta tentativa assim mesmo** — ver abaixo.
 *
 * ── Correção de um comentário que MENTIA aqui (22/08) ────────────────────
 *
 * Este bloco afirmava que `unavailable` NÃO contava tentativa. Não é o que o
 * consumidor faz: `reconcile()` (`delivery.ts`) chama `contarTentativa()` nos
 * três desfechos, e foi decisão de code review — é o que faz o
 * `ORDER BY report_attempts` rodiziar a fila e impede uma linha envenenada de
 * monopolizar o lote. `MAX_REPORT_ATTEMPTS` subiu de 10 para 60 exatamente
 * para absorver isso.
 *
 * O comentário errado tem custo real: em 22/08 ele me fez planejar uma
 * rotação de segredo com deploy dos dois lados defasado, calculando a janela
 * como gratuita. Não é — com `break` por passada, uma indisponibilidade
 * contínua gasta ~1 tentativa por minuto rodiziada pelo backlog, e com
 * backlog de uma linha são 60 minutos até PERDER aquele desfecho.
 * Comentário que descreve o chamador precisa ser conferido contra ele.
 *
 * O lado de lá é idempotente pela dedupeKey; reportar duas vezes é inofensivo.
 */
export type ReportOutcome = "ok" | "rejected" | "unavailable";

export async function reportDeliveryOutcome(outcome: {
  /** Escopo do update do outro lado — dedupeKey sozinho poderia casar linha
   * de outro tenant; o receptor EXIGE org. */
  orgId: string;
  dedupeKey: string;
  status: string;
  at: string;
  providerMessageId: string | null;
}): Promise<ReportOutcome> {
  // O chamador atual (reconcile) já pré-garante o secret; esta guarda existe
  // para chamadores futuros — não é o caminho testado.
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (!secret) return "unavailable";

  const rawBody = JSON.stringify(outcome);
  const timestamp = String(Date.now());
  try {
    const res = await fetchWithTimeout(
      `${BASE()}/api/webhooks/max`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-max-timestamp": timestamp,
          "x-max-signature": sign(timestamp, rawBody, secret),
        },
        body: rawBody,
      },
      IMOBPRO_TIMEOUT_MS
    );
    if (!res.ok) {
      // Integração (não a linha): 404 rota ainda não deployada; 5xx (inclui o
      // 503 "sem secret" de lá); 408/429 timeout/rate-limit; 401/403 drift de
      // secret/proteção de deploy — auth não é defeito de payload, e tratá-la
      // como recusa queimaria o teto de tudo durante uma rotação capenga.
      // Recusa de payload é o resto (400/422).
      console.warn(`[cm] report de entrega ${res.status} (${outcome.dedupeKey})`);
      const transitorio =
        res.status === 404 || res.status === 408 || res.status === 429 ||
        res.status === 401 || res.status === 403 || res.status >= 500;
      return transitorio ? "unavailable" : "rejected";
    }
    return "ok";
  } catch (err) {
    console.warn(
      "[cm] report de entrega falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return "unavailable";
  }
}

/**
 * Alerta de canal: a instância Z-API caiu, ou voltou. Vira e-mail no ImobPro.
 *
 * Mesma direção e MESMO secret do `reportDeliveryOutcome` acima
 * (`MAX_WEBHOOK_SECRET`) — é o Max falando com o Contractmaker, e o segredo é
 * de SERVIÇO, não de tenant. Rota irmã: `POST /api/webhooks/max/alert`.
 *
 * A spec previa `/api/agents/alert`. Aquela família de lá é Bearer por ORG, e
 * este evento é da instância inteira — uma só, compartilhada pelos três
 * tenants. Não existe org de onde tirar o token, e escolher uma seria mentir
 * sobre o escopo.
 *
 * **A ORDEM das chaves faz parte do contrato.** A assinatura é sobre a string
 * crua, e `JSON.stringify` preserva ordem de inserção — trocar `at` e `evento`
 * de lugar muda o byte e, com ele, o hex. Travado por vetor fixo nos dois
 * repos (`hmac-parity.test.ts`).
 *
 * Devolve boolean, não o tri-estado do report de entrega: aqui não existe fila
 * com contador de tentativas para proteger. **Falso = não carimba**, e a
 * passada seguinte do cron reenvia — é assim que o retry acontece, sem código
 * de retry. Por isso o receptor devolve 500 quando o e-mail não sai: um 200
 * mentiroso perderia o alerta para sempre.
 */
export type AlertaDeCanal =
  | { evento: "zapi_desconectada"; at: string; represadas: number }
  | { evento: "zapi_reconectada"; at: string; foraPorMs: number };

export async function reportAlert(alerta: AlertaDeCanal): Promise<boolean> {
  const secret = process.env.MAX_WEBHOOK_SECRET;
  if (!secret) {
    // Mesmo default seguro do report de entrega: sem secret a integração está
    // desligada. Ruidoso porque aqui o silêncio é o defeito — quem ligou o
    // alerta e não viu e-mail precisa achar a explicação no log.
    console.error(
      "[cm] MAX_WEBHOOK_SECRET ausente — alerta de canal NÃO enviado " +
        `(${alerta.evento})`
    );
    return false;
  }

  const rawBody = JSON.stringify(alerta);
  const timestamp = String(Date.now());
  try {
    const res = await fetchWithTimeout(
      `${BASE()}/api/webhooks/max/alert`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-max-timestamp": timestamp,
          "x-max-signature": sign(timestamp, rawBody, secret),
        },
        body: rawBody,
      },
      // Teto PRÓPRIO, e maior: o receptor manda o e-mail antes de responder.
      // Ver o comentário de IMOBPRO_ALERT_TIMEOUT_MS — errar para baixo aqui
      // produz alerta duplicado em série, não alerta perdido.
      IMOBPRO_ALERT_TIMEOUT_MS
    );
    if (!res.ok) {
      /**
       * QUALQUER não-2xx devolve false, e false significa RETENTAR na próxima
       * passada — inclusive 400. É diferente do `reportDeliveryOutcome` acima,
       * que classifica 4xx como "recusado" e desiste, e a diferença é
       * deliberada: lá o pior caso é um desfecho de entrega perdido, aqui é
       * ninguém saber que o canal caiu.
       *
       * O custo assumido: um 400 por divergência de contrato (campo
       * renomeado num lado só) vira laço de uma tentativa por minuto até
       * alguém consertar. Ruidoso, e ruidoso é o lado certo de errar — mas a
       * defesa de verdade contra isso é o vetor fixo de paridade, que quebra
       * no CI antes de qualquer deploy.
       */
      console.error(`[cm] alerta de canal recusado (${res.status}): ${alerta.evento}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      "[cm] alerta de canal falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}
