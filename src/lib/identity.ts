import { listOrgs, orgById, type OrgConfig } from "./orgs";
import { query } from "./db";
import { normalizeBrPhone } from "./phone";

/**
 * Quem está falando — e, principalmente, POR QUAL imobiliária.
 *
 * O telefone não responde isso sozinho. No ImobPro, `OrgMembership` não é única
 * por usuário (o mesmo gerente pode ser membro de duas casas) e
 * `SplitRecipient.phone` não tem unique nenhum (o corretor que trabalha com duas
 * está cadastrado nas duas). Antes daqui, o Max percorria as orgs e parava na
 * PRIMEIRA que casasse — o desempate saía da ordem de cadastro, e em produção
 * isso atribuía um usuário da Fincasa ao RE/MAX Trio, respondendo com a persona
 * e a base da imobiliária errada.
 *
 * A regra agora: **um candidato segue, nenhum é desconhecido, dois ou mais o Max
 * pergunta.** Nunca escolhe.
 */

export interface Candidate {
  orgId: string;
  orgName: string;
  /** Hoje só `user`; `broker` entra quando o lookup de corretor existir. */
  kind: "user";
  userId: string;
  userName: string | null;
}

export type Identity =
  | { kind: "resolved"; org: OrgConfig; candidate: Candidate }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "pending"; candidates: Candidate[] }
  | { kind: "unknown" };

const BASE = () => process.env.CONTRACTMAKER_API_URL ?? "https://imobpro.ia.br";

/**
 * Varre TODAS as orgs e coleta todos os acertos.
 *
 * A varredura completa é o ponto: parar no primeiro acerto é justamente o que
 * escondia a ambiguidade. Custa uma chamada por org — com poucos tenants é
 * barato, e a partir de algumas dezenas isto vira um endpoint de plataforma.
 *
 * Desde a correção do vazamento (PR #240), `by-phone` só encontra quem é da org
 * do token, então cada acerto aqui é um vínculo REAL — antes, qualquer token
 * achava qualquer pessoa e a varredura devolveria todas as orgs sempre.
 */
async function scanOrgs(e164: string): Promise<Candidate[]> {
  const found: Candidate[] = [];

  for (const org of await listOrgs()) {
    try {
      const res = await fetch(
        `${BASE()}/api/users/by-phone?phone=${encodeURIComponent(e164)}`,
        { headers: { Authorization: `Bearer ${org.apiToken}` } }
      );
      if (res.status === 404) continue;
      if (!res.ok) {
        console.warn(`[identity] by-phone ${res.status} na org ${org.orgId}`);
        continue;
      }
      const r = (await res.json()) as { userId?: string; name?: string | null };
      if (r.userId) {
        found.push({
          orgId: org.orgId,
          orgName: org.orgName,
          kind: "user",
          userId: r.userId,
          userName: r.name ?? null,
        });
      }
    } catch (err) {
      // Uma org fora do ar não pode impedir que as outras respondam — mas
      // também não pode virar "não achei", que seria uma resposta errada com
      // cara de certa. Por isso o erro é logado e a varredura continua.
      console.warn(
        `[identity] falha na org ${org.orgId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return found;
}

interface ChoiceRow extends Record<string, unknown> {
  chosen_org_id: string | null;
  candidates: Candidate[];
}

export async function resolveIdentity(rawPhone: string): Promise<Identity> {
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return { kind: "unknown" };

  // Escolha anterior tem precedência: quem já disse de qual imobiliária fala
  // não é perguntado de novo a cada mensagem.
  const rows = await query<ChoiceRow>(
    `SELECT chosen_org_id, candidates FROM phone_org_choice WHERE phone = $1`,
    [e164]
  );
  const saved = rows[0];

  if (saved?.chosen_org_id) {
    const org = await orgById(saved.chosen_org_id);
    const candidate = saved.candidates.find(
      (c) => c.orgId === saved.chosen_org_id
    );
    // Org desativada ou candidato sumido: a escolha caducou e o telefone volta
    // à varredura em vez de apontar para um vínculo que não existe mais.
    if (org && candidate) return { kind: "resolved", org, candidate };
    await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]);
  }

  const candidates = await scanOrgs(e164);

  if (candidates.length === 0) {
    if (saved) await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]);
    return { kind: "unknown" };
  }

  if (candidates.length === 1) {
    const org = await orgById(candidates[0].orgId);
    if (!org) return { kind: "unknown" };
    if (saved) await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]);
    return { kind: "resolved", org, candidate: candidates[0] };
  }

  // Dois ou mais: registra as opções e devolve `pending` (já perguntamos antes)
  // ou `ambiguous` (é a primeira vez).
  await query(
    `INSERT INTO phone_org_choice (phone, candidates, asked_at, updated_at)
     VALUES ($1, $2::jsonb, now(), now())
     ON CONFLICT (phone) DO UPDATE
       SET candidates = EXCLUDED.candidates, updated_at = now()`,
    [e164, JSON.stringify(candidates)]
  );

  return saved?.candidates?.length
    ? { kind: "pending", candidates }
    : { kind: "ambiguous", candidates };
}

/**
 * Casa a resposta do usuário com uma das opções oferecidas.
 *
 * Aceita o número da lista ("2") ou um trecho do nome ("ativa"). Deliberadamente
 * conservador: **exige um acerto único**. "RE/MAX" casaria com três
 * imobiliárias, e escolher uma delas seria repetir o erro que este módulo
 * existe para corrigir.
 */
export function matchChoice(
  texto: string,
  candidates: Candidate[]
): Candidate | null {
  const t = texto.trim().toLowerCase();
  if (!t) return null;

  const porNumero = Number(t.replace(/\D/g, ""));
  if (
    /^\s*\d+\s*$/.test(t) &&
    porNumero >= 1 &&
    porNumero <= candidates.length
  ) {
    return candidates[porNumero - 1];
  }

  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const alvo = norm(t);
  const hits = candidates.filter((c) => norm(c.orgName).includes(alvo));
  return hits.length === 1 ? hits[0] : null;
}

export async function saveChoice(
  rawPhone: string,
  orgId: string
): Promise<void> {
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return;
  await query(
    `UPDATE phone_org_choice
        SET chosen_org_id = $2, chosen_at = now(), updated_at = now()
      WHERE phone = $1`,
    [e164, orgId]
  );
}

/** Texto da pergunta. Numerado porque responder "2" é mais fácil que digitar. */
export function askWhichOrg(candidates: Candidate[]): string {
  const lista = candidates
    .map((c, i) => `${i + 1}. ${c.orgName}`)
    .join("\n");
  return (
    "Seu número está cadastrado em mais de uma imobiliária. " +
    "Por qual delas você fala agora?\n\n" +
    lista +
    "\n\nResponda com o número ou o nome."
  );
}
