import { orgById } from "./orgs";
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
