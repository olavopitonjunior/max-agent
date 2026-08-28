import { orgById } from "./orgs";
import { normalizeBrPhone } from "./phone";
import { fetchWithTimeout, imobproBase, IMOBPRO_TIMEOUT_MS } from "./http";
import {
  CAMPOS_PROIBIDOS_AO_BROKER,
  type ScopeQueryVerb,
  type ScopeSubject,
} from "@/graph/scope-contract";
import type { Candidate } from "./identity";

/**
 * Cliente do `POST /api/agents/scope-query` — a leitura de negócio do Max.
 *
 * A rota está em produção desde 2026-08-28 (contractmaker#439). Este arquivo é
 * o consumidor que faltava; o contrato e o vetor fixo já estão em
 * `@/graph/scope-contract`.
 *
 * ── O que este cliente NÃO faz, e é o ponto ───────────────────────────────
 *
 * **Não decide escopo, não filtra campo e não conhece papel.** Quem decide o
 * que volta é o servidor: ele refaz o vínculo telefone→sujeito, aplica
 * `dealScopeWhere`/`proposalScopeWhere` no `where`, e PROJETA por tipo de
 * sujeito. Reimplementar qualquer pedaço disso aqui criaria a segunda
 * autoridade que diverge em silêncio — o modo de falha que `docs/max.md` §11.5
 * descreve.
 *
 * O `phone` vai junto do `subject` de propósito: o Max **não é acreditado** a
 * afirmar quem é a pessoa. Divergência entre os dois é 403 no servidor, e aqui
 * vira `null`.
 */

export interface ResultadoDeLeitura {
  items: unknown[];
  truncated: boolean;
}

/**
 * `null` é resultado NORMAL e fail-closed: telefone que não resolve, sujeito
 * que não confere, org fora do ar, 5xx, timeout.
 *
 * Quem chama transforma isso em "não consegui consultar agora" — nunca em
 * lista vazia apresentada como fato, que seria mentir para a pessoa sobre a
 * carteira dela.
 */
export async function consultarEscopo(params: {
  orgId: string;
  rawPhone: string;
  subject: ScopeSubject;
  verb: ScopeQueryVerb;
  args?: Record<string, unknown>;
}): Promise<ResultadoDeLeitura | null> {
  const org = await orgById(params.orgId);
  if (!org) return null;
  const e164 = normalizeBrPhone(params.rawPhone);
  if (!e164) return null;

  try {
    const res = await fetchWithTimeout(
      `${imobproBase()}/api/agents/scope-query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${org.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          verb: params.verb,
          subject: params.subject,
          phone: e164,
          args: params.args ?? {},
        }),
      },
      IMOBPRO_TIMEOUT_MS
    );

    if (!res.ok) {
      // 403 é "o sujeito não confere com o telefone" — o servidor recusando
      // uma afirmação que o Max não podia fazer. Merece log alto: ou é bug de
      // resolução de identidade, ou é o sinal de ataque que o 403 existe para
      // não esconder.
      console.warn(
        `[scope] ${params.verb} ${res.status} na org ${params.orgId}`
      );
      return null;
    }

    const r = (await res.json()) as { items?: unknown; truncated?: unknown };
    if (!Array.isArray(r.items)) return null;
    return { items: r.items, truncated: r.truncated === true };
  } catch (err) {
    console.warn(
      `[scope] ${params.verb} falhou na org ${params.orgId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/** O `subject` que o servidor vai reconferir, derivado da identidade do turn. */
export function subjectDe(identity: Candidate): ScopeSubject {
  return identity.kind === "user"
    ? { kind: "user", userId: identity.userId }
    : { kind: "broker", splitRecipientId: identity.splitRecipientId };
}

/**
 * Rede de segurança de defesa em profundidade — regra 5 da governança.
 *
 * A projeção que vale é a do SERVIDOR, e esta função **não a substitui**: ela
 * não sabe o que deveria vir, só o que nunca pode vir. Existe porque o custo
 * de errar aqui é assimétrico: se o ImobPro regredir a projeção, o campo
 * proibido chega, entra no prompt e o modelo pode repeti-lo — e nenhum teste
 * deste repo pegaria, porque todos mockam a resposta.
 *
 * Descarta a linha inteira em vez de podar o campo. Podar produziria um item
 * meio-certo que parece correto no log; descartar produz uma ausência que
 * alguém investiga. E o `console.error` é deliberadamente alto: se isto
 * disparar, a projeção do outro lado quebrou.
 */
export function descartarSeVazou(
  items: unknown[],
  kind: "user" | "broker"
): unknown[] {
  if (kind !== "broker") return items;
  /**
   * Varre em PROFUNDIDADE, não só o topo.
   *
   * A projeção de hoje é plana, então a varredura rasa bastaria — mas esta
   * função existe justamente para pegar regressão do servidor que ela não pode
   * prever, e `deal.detail`/`proposal.detail` (PR 6b) são os verbos mais
   * propensos a aninhar dado de cliente sob um sub-objeto. Rasa, ela passaria
   * a mentir exatamente quando começasse a importar.
   */
  const achaProibido = (v: unknown): string[] => {
    if (!v || typeof v !== "object") return [];
    if (Array.isArray(v)) return v.flatMap(achaProibido);
    const aqui = CAMPOS_PROIBIDOS_AO_BROKER.filter((c) => Object.hasOwn(v, c));
    return [...aqui, ...Object.values(v).flatMap(achaProibido)];
  };

  return items.filter((it) => {
    if (!it || typeof it !== "object") return true;
    const vazou = achaProibido(it);
    if (vazou.length > 0) {
      console.error(
        `[scope] REGRESSÃO DE PROJEÇÃO: item do broker trouxe ${vazou.join(", ")} — descartado`
      );
      return false;
    }
    return true;
  });
}
