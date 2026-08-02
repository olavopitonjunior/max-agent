import { listOrgs, orgById, type OrgConfig } from "./orgs";
import { query } from "./db";
import { normalizeBrPhone } from "./phone";

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

export interface Identity {
  orgId: string;
  orgName: string;
  userId: string;
  userName: string | null;
}

/**
 * Telefone → tenant + usuário.
 *
 * Não existe endpoint "de qual org é este telefone": o Bearer do ImobPro deriva
 * a org do dono do token, então a busca é uma por org, em sequência. Como
 * `User.phone` lá é unique GLOBAL, há no máximo um acerto — e a primeira
 * resposta positiva encerra a varredura.
 *
 * O cache guarda também o NEGATIVO. Sem isso, cada mensagem de um número
 * desconhecido (cliente que respondeu a uma notificação, engano, spam) custaria
 * uma chamada por tenant, para sempre.
 */
export async function identifyByPhone(rawPhone: string): Promise<Identity | null> {
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return null;

  const cached = await query<{
    org_id: string | null;
    user_id: string | null;
    user_name: string | null;
  }>(
    `SELECT org_id, user_id, user_name FROM phone_org_cache
      WHERE phone = $1 AND resolved_at > now() - interval '24 hours'`,
    [e164]
  );
  if (cached.length > 0) {
    const c = cached[0];
    if (!c.org_id || !c.user_id) return null;
    const org = await orgById(c.org_id);
    return org
      ? { orgId: c.org_id, orgName: org.orgName, userId: c.user_id, userName: c.user_name }
      : null;
  }

  let found: { org: OrgConfig; user: { userId: string; name?: string } } | null = null;
  for (const org of await listOrgs()) {
    try {
      const r = await get<{ userId: string; orgId: string; name?: string }>(
        `/api/users/by-phone?phone=${encodeURIComponent(e164)}`,
        org.apiToken
      );
      if (r?.userId) {
        found = { org, user: { userId: r.userId, name: r.name } };
        break;
      }
    } catch (err) {
      // Uma org fora do ar não pode impedir que as outras respondam.
      console.warn(
        `[cm] by-phone falhou na org ${org.orgId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  await query(
    `INSERT INTO phone_org_cache (phone, org_id, user_id, user_name, resolved_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (phone) DO UPDATE
       SET org_id = EXCLUDED.org_id,
           user_id = EXCLUDED.user_id,
           user_name = EXCLUDED.user_name,
           resolved_at = now()`,
    [e164, found?.org.orgId ?? null, found?.user.userId ?? null, found?.user.name ?? null]
  );

  return found
    ? {
        orgId: found.org.orgId,
        orgName: found.org.orgName,
        userId: found.user.userId,
        userName: found.user.name ?? null,
      }
    : null;
}

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
      body: JSON.stringify({ agentKey: "max", provider: "anthropic", ...usage }),
    });
  } catch (err) {
    // Fire-and-forget: perder a contabilidade de um turn é ruim, não responder
    // ao usuário por causa disso é pior.
    console.warn("[cm] reportUsage falhou:", err instanceof Error ? err.message : String(err));
  }
}
