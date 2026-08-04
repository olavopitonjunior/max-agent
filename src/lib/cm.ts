import { orgById } from "./orgs";
import { normalizeBrPhone } from "./phone";
import { query } from "./db";

/**
 * Cliente das APIs do ImobPro.
 *
 * Todo dado de tenant entra por aqui, via Bearer — este serviço não tem
 * credencial do Postgres da aplicação, de propósito. Se o Max for
 * comprometido, o atacante herda o que os escopos do token permitem, não o
 * banco inteiro.
 */

const BASE = () => process.env.CONTRACTMAKER_API_URL ?? "https://imobpro.ia.br";

async function get<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${BASE()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
  instructions: { composed?: string } | null;
  budget?: { pct?: number } | null;
}

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
  const res = await fetch(`${BASE()}/api/agents/knowledge/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${org.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentKey: "max", query: query_, topK }),
  });
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
    const res = await fetch(`${BASE()}/api/agents/media/transcribe`, {
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
    });
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
    const res = await fetch(
      `${BASE()}/api/agents/broker-scope?phone=${encodeURIComponent(e164)}`,
      { headers: { Authorization: `Bearer ${org.apiToken}` } }
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

  const res = await fetch(`${BASE()}/api/forms`, {
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
  });

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
 * Reporta o custo do turn. Uma linha POR MODELO: um turn multi-modelo somado
 * num bucket só cobraria Sonnet a preço de Haiku, e esse número alimenta o teto
 * mensal por agente e o painel.
 */
export async function reportUsage(
  orgId: string,
  usage: {
    model: string;
    promptTokens: number;
    completionTokens?: number;
    latencyMs: number;
    success?: boolean;
    dealId?: string | null;
  }
): Promise<void> {
  const org = await orgById(orgId);
  if (!org) return;
  try {
    await fetch(`${BASE()}/api/agents/usage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${org.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentKey: "max", provider: "openrouter", ...usage }),
    });
  } catch (err) {
    // Fire-and-forget: perder a contabilidade de um turn é ruim, não responder
    // ao usuário por causa disso é pior.
    console.warn("[cm] reportUsage falhou:", err instanceof Error ? err.message : String(err));
  }
}
