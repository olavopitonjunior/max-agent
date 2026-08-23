import { listOrgs, orgById, type OrgConfig } from "./orgs";
import { query } from "./db";
import { normalizeBrPhone } from "./phone";
import { fetchWithTimeout, imobproBase, IMOBPRO_TIMEOUT_MS } from "./http";

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
  /**
   * Papel na org (`membership.role`), como o `by-phone` já devolvia e este
   * módulo descartava. Entra porque a política de capabilities é indexada por
   * ele (`byRole`).
   *
   * ⚠️ **Ele pode estar ARBITRARIAMENTE velho, e não só 15 minutos.** Uma
   * versão anterior deste comentário dizia "até `POSITIVE_TTL_MIN`", e estava
   * errada: quem já desambiguou de qual imobiliária fala é resolvido pela
   * `phone_org_choice`, que devolve o candidato GRAVADO na hora da escolha e
   * nunca revarre — e aquela tabela **não tem TTL**, por decisão (é escolha da
   * pessoa, não cache; ver a migration 007).
   *
   * Duas consequências reais, achadas em code review:
   *  - candidato gravado ANTES desta entrega não tem `role`, e isso é
   *    permanente para aquele telefone: resolve para nenhuma capability;
   *  - papel rebaixado fica congelado, então revogar o papel na plataforma não
   *    revoga o que o Max oferece.
   *
   * **Por que ainda assim entra, hoje:** nada consome `state.policy` (PR 4 é
   * receptor inerte), e para `kind: "user"` o servidor do ImobPro ainda
   * estreita no `where` — papel velho muda o que se OFERECE, não o que se LÊ.
   * Não vale para `kind: "broker"`, que não tem RBAC — mas broker não tem
   * `role`, então este campo não o afeta.
   *
   * **Isto NÃO é aceitável quando o PR 6 ligar as leituras.** A dívida está
   * nomeada na §6.3 da spec: ou a escolha passa a revalidar o papel, ou a
   * resolução migra para o servidor, que é quem sabe papel e RBAC juntos.
   *
   * `null` quando a resposta não trouxe — e papel desconhecido resolve para
   * NENHUMA capability, nunca para um default.
   */
  role: string | null;
}

/**
 * Corretor atribuído pela imobiliária (`SplitRecipient.maxEnabled`).
 *
 * **Não guarda `dealIds`.** A lista muda quando alguém entra ou sai da comissão
 * de um negócio, e um candidato congelado numa linha de `phone_org_choice`
 * continuaria dando acesso a negócio do qual o corretor já saiu. Os negócios
 * seriam buscados na hora, quando houver caso de uso.
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
  /** `alreadyGreeted`: este número desconhecido JÁ recebeu a apresentação —
   * a partir daí é silêncio até o cache negativo expirar. */
  | { kind: "unknown"; alreadyGreeted?: boolean };

const BASE = imobproBase;

// ── Cache da varredura ───────────────────────────────────────────────────
//
// A migration 003 dropou a `phone_org_cache` porque guardar UMA org escondia
// ambiguidade — mas saiu sem repor nada, e desde então TODA mensagem pagava a
// varredura completa (2 fetches ao ImobPro por org). O pior caso é o número
// desconhecido: spam virava amplificador de custo, com o Max ainda respondendo
// ao estranho a cada mensagem.
//
// Este cache guarda só o que não é decisão de ninguém: o RESULTADO da varredura
// quando ele é inequívoco (zero ou um candidato). Dois ou mais continua na
// `phone_org_choice`, que registra a escolha da PESSOA e tem precedência.

/** Vínculo confirmado: TTL curto — desativação precisa valer logo. */
const POSITIVE_TTL_MIN = 15;
/** Não achou ninguém: TTL longo — cadastro novo pode esperar o cache vencer. */
const NEGATIVE_TTL_HOURS = 24;

interface IdentityCacheRow extends Record<string, unknown> {
  payload: Candidate | null;
  negative: boolean;
  greeted: boolean;
}

async function readCache(e164: string): Promise<IdentityCacheRow | null> {
  const rows = await query<IdentityCacheRow>(
    `SELECT payload, negative, greeted FROM identity_cache
      WHERE phone = $1 AND expires_at > now()`,
    [e164]
  );
  return rows[0] ?? null;
}

async function writeCache(
  e164: string,
  entry: { candidate: Candidate } | { negative: true }
): Promise<void> {
  const negative = !("candidate" in entry);
  await query(
    `INSERT INTO identity_cache (phone, payload, negative, greeted, expires_at)
     VALUES ($1, $2::jsonb, $3, false,
             now() + ($4 || ' minutes')::interval)
     ON CONFLICT (phone) DO UPDATE
       SET payload = EXCLUDED.payload,
           negative = EXCLUDED.negative,
           -- Preserva o greeted: renovar o cache não reapresenta o Max.
           greeted = identity_cache.greeted AND EXCLUDED.negative,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
    [
      e164,
      negative ? null : JSON.stringify(entry.candidate),
      negative,
      String(negative ? NEGATIVE_TTL_HOURS * 60 : POSITIVE_TTL_MIN),
    ]
  );
}

/** O número desconhecido recebeu a apresentação — não repetir até expirar. */
export async function markGreeted(rawPhone: string): Promise<void> {
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return;
  await query(
    `UPDATE identity_cache SET greeted = true, updated_at = now() WHERE phone = $1`,
    [e164]
  );
}

/**
 * Invalidação total — reservada para operações administrativas (ex.: direito
 * ao esquecimento com telefone, manutenção sem). O provisionamento de org usa
 * as variantes SELETIVAS abaixo: o wipe completo a cada upsert/rotação apagava
 * os `greeted` de todo mundo e reinstalava o custo que o cache existe para
 * evitar (achado do code review do PR #5).
 */
export async function clearIdentityCache(rawPhone?: string): Promise<void> {
  if (!rawPhone) {
    await query(`DELETE FROM identity_cache`);
    return;
  }
  const e164 = normalizeBrPhone(rawPhone);
  if (!e164) return;
  await query(`DELETE FROM identity_cache WHERE phone = $1`, [e164]);
}

/**
 * Org NOVA (ou reativada, ou token rotacionado): só os NEGATIVOS caducaram —
 * um número que "não era de ninguém" pode ser usuário dela. Os positivos
 * continuam válidos (apontam para outras orgs) e os `greeted` sobrevivem.
 */
export async function clearNegativeIdentityCache(): Promise<void> {
  await query(`DELETE FROM identity_cache WHERE negative`);
}

/** Org DESATIVADA: caducam só os vínculos positivos que apontavam para ela. */
export async function clearIdentityCacheForOrg(orgId: string): Promise<void> {
  await query(
    `DELETE FROM identity_cache WHERE NOT negative AND payload->>'orgId' = $1`,
    [orgId]
  );
}

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
interface ScanResult {
  candidates: Candidate[];
  /**
   * Alguma org não respondeu (timeout, 5xx, exceção). O resultado ainda serve
   * para SEGUIR a conversa — mas não para o cache: "não achei porque o ImobPro
   * caiu" gravado como negativo de 24h silenciaria um usuário legítimo por um
   * dia inteiro (achado do code review do PR #5).
   */
  degraded: boolean;
}

async function scanOrgs(e164: string): Promise<ScanResult> {
  const found: Candidate[] = [];
  let degraded = false;

  for (const org of await listOrgs()) {
    try {
      const res = await fetchWithTimeout(
        `${BASE()}/api/users/by-phone?phone=${encodeURIComponent(e164)}`,
        { headers: { Authorization: `Bearer ${org.apiToken}` } },
        IMOBPRO_TIMEOUT_MS
      );

      // 404 não encerra a org: quem não é USUÁRIO da plataforma ainda pode ser
      // CORRETOR atribuído. São cadastros diferentes, e a maioria dos corretores
      // não tem login.
      if (res.status === 404) {
        const broker = await scanBroker(org, e164);
        if (broker.degraded) degraded = true;
        if (broker.candidate) found.push(broker.candidate);
        continue;
      }
      if (!res.ok) {
        console.warn(`[identity] by-phone ${res.status} na org ${org.orgId}`);
        degraded = true;
        continue;
      }
      const r = (await res.json()) as {
        userId?: string;
        name?: string | null;
        role?: string | null;
      };
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
          role: r.role ?? null,
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
      degraded = true;
    }
  }

  return { candidates: found, degraded };
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
): Promise<{ candidate: BrokerCandidate | null; degraded: boolean }> {
  const res = await fetchWithTimeout(
    `${BASE()}/api/agents/broker-scope?phone=${encodeURIComponent(e164)}`,
    { headers: { Authorization: `Bearer ${org.apiToken}` } },
    IMOBPRO_TIMEOUT_MS
  );
  if (res.status === 404) return { candidate: null, degraded: false };
  if (!res.ok) {
    console.warn(`[identity] broker-scope ${res.status} na org ${org.orgId}`);
    // "Não consegui perguntar" não é "não é candidato" — ver ScanResult.
    return { candidate: null, degraded: true };
  }
  const r = (await res.json()) as {
    splitRecipientId?: string;
    label?: string;
  };
  if (!r.splitRecipientId) return { candidate: null, degraded: false };
  return {
    candidate: {
      orgId: org.orgId,
      orgName: org.orgName,
      kind: "broker",
      splitRecipientId: r.splitRecipientId,
      label: r.label ?? "",
    },
    degraded: false,
  };
}

interface ChoiceRow extends Record<string, unknown> {
  chosen_org_id: string | null;
  candidates: Candidate[];
}

export async function resolveIdentity(rawPhone: string): Promise<Identity> {
  const e164 = normalizeBrPhone(rawPhone);
  // Número que nem normaliza (internacional, formato estranho) não pode ser
  // cliente das imobiliárias — e também não entra no cache/greeted, que são
  // indexados por E.164. `alreadyGreeted: true` para NUNCA responder: sem
  // isso, cada mensagem de spam internacional ganhava a apresentação de novo
  // (achado do code review do PR #5).
  if (!e164) return { kind: "unknown", alreadyGreeted: true };

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

  // Cache da varredura — depois da escolha salva (que é decisão da pessoa e
  // tem precedência), antes dos fetches. FAIL-OPEN em tudo que é cache: uma
  // falha aqui não pode abortar um turn que a varredura resolveria — cache
  // quebrado degrada para o custo antigo, nunca para silêncio.
  const cached = await readCache(e164).catch((err) => {
    console.warn(
      "[identity] cache ilegível — segue sem ele:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  });
  if (cached) {
    if (cached.negative) {
      return { kind: "unknown", alreadyGreeted: cached.greeted };
    }
    if (cached.payload) {
      const org = await orgById(cached.payload.orgId);
      if (org) return { kind: "resolved", org, candidate: cached.payload };
      // Org do cache sumiu: invalida e cai na varredura.
      await clearIdentityCache(e164).catch(() => undefined);
    }
  }

  const { candidates, degraded } = await scanOrgs(e164);

  if (candidates.length === 0) {
    if (saved) await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]);
    // Só cacheia o negativo de uma varredura COMPLETA: "não achei porque uma
    // org estava fora" gravado por 24h silenciaria um usuário legítimo até o
    // TTL vencer. Degradada, a próxima mensagem re-varre.
    if (!degraded) await writeCache(e164, { negative: true }).catch(() => undefined);
    return { kind: "unknown", alreadyGreeted: false };
  }

  if (candidates.length === 1) {
    const org = await orgById(candidates[0].orgId);
    if (!org) return { kind: "unknown" };
    if (saved) await query(`DELETE FROM phone_org_choice WHERE phone = $1`, [e164]);
    // Mesmo raciocínio: com uma org fora do ar, o "candidato único" pode ser
    // um de dois — resolver AGORA está certo (é o comportamento pré-cache),
    // mas congelar isso por 15min esconderia a ambiguidade.
    if (!degraded) await writeCache(e164, { candidate: candidates[0] }).catch(() => undefined);
    return { kind: "resolved", org, candidate: candidates[0] };
  }

  // Dois ou mais: qualquer cache antigo deste telefone está desatualizado.
  await clearIdentityCache(e164).catch(() => undefined);

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
