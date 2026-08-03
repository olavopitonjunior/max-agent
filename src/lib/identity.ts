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

interface CandidateBase {
  orgId: string;
  orgName: string;
}

/** Usuário da plataforma: o escopo dele sai do RBAC, não desta camada. */
export interface UserCandidate extends CandidateBase {
  kind: "user";
  userId: string;
  userName: string | null;
}

/**
 * Corretor atribuído pela imobiliária (`SplitRecipient.maxEnabled`).
 *
 * **Não guarda `dealIds`.** A lista muda quando alguém entra ou sai da comissão
 * de um negócio, e um candidato congelado numa linha de `phone_org_choice`
 * continuaria dando acesso a negócio do qual o corretor já saiu. Os negócios
 * são buscados na hora, por `brokerDealIds`.
 */
export interface BrokerCandidate extends CandidateBase {
  kind: "broker";
  splitRecipientId: string;
  label: string;
}

export type Candidate = UserCandidate | BrokerCandidate;

/** Nome de exibição, seja qual for a classe. */
export function displayName(c: Candidate): string | null {
  return c.kind === "user" ? c.userName : c.label;
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

      // 404 não encerra a org: quem não é USUÁRIO da plataforma ainda pode ser
      // CORRETOR atribuído. São cadastros diferentes, e a maioria dos corretores
      // não tem login.
      if (res.status === 404) {
        const broker = await scanBroker(org, e164);
        if (broker) found.push(broker);
        continue;
      }
      if (!res.ok) {
        console.warn(`[identity] by-phone ${res.status} na org ${org.orgId}`);
        continue;
      }
      const r = (await res.json()) as { userId?: string; name?: string | null };
      if (r.userId) {
        // Quem é usuário E corretor na mesma casa entra como usuário: o escopo
        // do RBAC é o mais específico dos dois, e não seria correto estreitá-lo
        // para "só os negócios em que ele é comissionado".
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

/**
 * Corretor atribuído naquela org, ou nada.
 *
 * O 404 do `broker-scope` cobre desconhecido, não-atribuído, inativo e
 * telefone duplicado dentro da org — de propósito: distinguir os casos
 * confirmaria a existência de um cadastro para quem tem token de outra casa.
 * Aqui todos viram o mesmo "não é candidato".
 */
async function scanBroker(
  org: OrgConfig,
  e164: string
): Promise<BrokerCandidate | null> {
  const res = await fetch(
    `${BASE()}/api/agents/broker-scope?phone=${encodeURIComponent(e164)}`,
    { headers: { Authorization: `Bearer ${org.apiToken}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`[identity] broker-scope ${res.status} na org ${org.orgId}`);
    return null;
  }
  const r = (await res.json()) as {
    splitRecipientId?: string;
    label?: string;
  };
  if (!r.splitRecipientId) return null;
  return {
    orgId: org.orgId,
    orgName: org.orgName,
    kind: "broker",
    splitRecipientId: r.splitRecipientId,
    label: r.label ?? "",
  };
}

/**
 * Os negócios do corretor, buscados na hora.
 *
 * Fora do `Candidate` de propósito — ver `BrokerCandidate`. Uma lista vazia é
 * resposta válida ("não participa de nenhum"); `null` é falha de leitura, e o
 * chamador tem que tratar diferente: com `null`, não falar de negócio nenhum.
 */
export async function brokerDealIds(
  org: OrgConfig,
  rawPhone: string
): Promise<string[] | null> {
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return null;
  try {
    const res = await fetch(
      `${BASE()}/api/agents/broker-scope?phone=${encodeURIComponent(e164)}`,
      { headers: { Authorization: `Bearer ${org.apiToken}` } }
    );
    if (!res.ok) return null;
    const r = (await res.json()) as { dealIds?: string[] };
    return Array.isArray(r.dealIds) ? r.dealIds : null;
  } catch {
    return null;
  }
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
