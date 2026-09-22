import type { Candidate } from "@/lib/identity";

/**
 * Capabilities do Max e a resolução da política efetiva de um sujeito.
 *
 * ── O que este módulo NÃO faz, e é o ponto mais importante dele ────────────
 *
 * **Ele não decide nada.** O `gate` chama `resolverPolitica` uma vez por turn e
 * guarda o resultado em `state.policy`; nenhum call-site consome esse campo
 * ainda. O consumo entra no PR 6, junto com as tools de leitura que a política
 * de fato governa.
 *
 * Isso é deliberado e foi condição de aprovação do PR 4. A regra 2 da
 * governança ("receptor primeiro, inerte") cria uma janela entre o deploy deste
 * repo e o do ImobPro, e nessa janela `politica` chega **ausente** — que por
 * fail-closed significa NENHUMA capability. Se este PR já filtrasse as tools
 * oferecidas pela política, o efeito em produção seria o Max **parar de propor
 * criação de formulário**: `propor_criacao` é a única capability que ele
 * exerce hoje, e ela sumiria em silêncio até o outro lado subir. Regressão, não
 * inércia. O teste `politica ausente NÃO tira propor_criacao` existe para que
 * essa distinção não dependa de alguém lembrar dela.
 *
 * ── Fail-closed é sobre o que a política CONCEDE ──────────────────────────
 *
 * Ausência de política = nenhuma capability (regra 3 da governança). Não
 * confundir com "nenhuma tool": a oferta de tool hoje é decidida por
 * `podeEscrever` + `shouldOfferTools`, e continua sendo até o PR 6.
 *
 * ── ⚠️ Duas coisas que quem escrever o PR 6 PRECISA ler antes ─────────────
 *
 * **1. Esta resolução NÃO aplica o RBAC.** A fórmula da spec §3.1 tem quatro
 * termos, e o quarto é "o que o RBAC do ImobPro permite àquele userId". Ele
 * **não é aplicado aqui** e não tem como ser: o RBAC mora no outro servidor.
 * `state.policy` é o teto do que se pode OFERECER, e nada mais. Quem volta a
 * ler este campo não pode concluir que ele já vem cruzado com permissão — o
 * cruzamento acontece no `where` do `scope-query` (PR 5), no ImobPro.
 *
 * **2. Para `kind: "user"` há uma segunda trava; para `kind: "broker"` NÃO
 * HÁ.** Um `SplitRecipient` não tem `User`, logo não tem `EffectivePermissions`
 * e não passa por `dealScopeWhere`/`proposalScopeWhere`. Para ele, o
 * `brokerDefault` (mais o `byRecipient`) é o **único** freio que existe — e o
 * `allow` de um override SOMA ao default, então ele é a única porta pela qual
 * este módulo ALARGA alguma coisa.
 *
 * Isso corrige uma versão anterior deste cabeçalho, que afirmava sem ressalva
 * que "quais linhas voltam continua sendo decidido pelo RBAC". Verdadeiro para
 * usuário, **falso para corretor comissionado** — e a diferença é exatamente
 * onde um erro custa PII de cliente. A projeção por tipo de sujeito (regra 5
 * da governança), entregue no PR 5, é o que cerca esse caso no servidor.
 *
 * ── `role` pode estar arbitrariamente velho ───────────────────────────────
 *
 * Uma versão anterior deste arquivo dizia "até 15 min, o TTL do cache de
 * identidade". **Falso.** Quem já desambiguou de qual imobiliária fala é
 * resolvido pela `phone_org_choice`, que devolve o candidato GRAVADO na hora da
 * escolha e nunca revarre — e aquela tabela não tem TTL, por decisão (é
 * escolha da pessoa, não cache). Duas consequências reais:
 *
 *  - candidato gravado ANTES desta entrega não tem `role` nenhum, e resolve
 *    para `[]` — fail-closed, seguro, e silencioso;
 *  - papel rebaixado continua congelado, então revogar o papel não revoga o
 *    que se oferece.
 *
 * Tolerável hoje **porque nada consome** e porque, para usuário, o servidor
 * ainda estreita. Não é tolerável quando o PR 6 ligar as leituras: ver a dívida
 * nomeada na §6.3 da spec.
 */

/**
 * O catálogo. Capability que não está aqui não existe — nem para conceder, nem
 * para negar.
 *
 * `audio.reply` já entra, embora só o PR 10 vá consumi-la: capability é string
 * gravada em JSON no banco do ImobPro, e declarar o nome antes de precisar dele
 * evita a migração de dado que a renomeação exigiria depois.
 */
export const CAPABILITIES = [
  "deal.list",
  "deal.detail",
  "deal.pending",
  "proposal.list",
  "proposal.detail",
  "proposal.create",
  "form.create",
  "notify.manual",
  "audio.reply",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CATALOGO = new Set<string>(CAPABILITIES);

/**
 * A política como o ImobPro a emite, em `GET /api/agents/profile`.
 *
 * Todos os campos são opcionais **de propósito**: durante a janela da regra 2 a
 * rota ainda não os devolve, e um parse que exigisse a forma completa
 * transformaria "o emissor ainda não subiu" em erro de turn.
 */
export interface MaxPolicy {
  /** `{ [rolePreset]: Capability[] }` — papel ausente = nenhuma (fail-closed). */
  byRole?: Record<string, string[]> | null;
  /** `{ [splitRecipientId]: { allow?, deny? } }`. `deny` vence sempre. */
  byRecipient?: Record<string, { allow?: string[]; deny?: string[] }> | null;
  /** Preset de quem é corretor comissionado sem override. Fail-closed. */
  brokerDefault?: string[] | null;
}

/**
 * Capability desconhecida é IGNORADA, não é erro.
 *
 * Um rollback de código para uma versão com catálogo menor não pode quebrar a
 * política que uma versão mais nova gravou — ela simplesmente concede menos.
 * Erro aqui transformaria rollback em indisponibilidade.
 */
function apenasConhecidas(lista: unknown): Capability[] {
  // `Array.isArray` e não `?? []`: `maxPolicy` chega de `get<T>()` no `cm.ts`,
  // que é um cast NÃO VALIDADO de JSON de rede. Um `byRole: { sales: "x" }`
  // — emissor antigo, linha editada à mão — faria `.filter` lançar dentro do
  // `gate`, que não tem catch, e o turn morreria. O módulo promete o oposto
  // logo acima ("erro aqui transformaria rollback em indisponibilidade"), e a
  // promessa não pode depender de o outro lado estar bem-comportado.
  if (!Array.isArray(lista)) return [];
  return lista.filter((c): c is Capability => typeof c === "string" && CATALOGO.has(c));
}

/**
 * Busca em `byRole` por propriedade PRÓPRIA, dizendo se a chave EXISTE.
 *
 * `politica.byRole["constructor"]` num objeto vindo de JSON.parse devolveria a
 * função do protótipo, não `undefined` — e ela não é array, então o guard acima
 * já a converteria em `[]`. O `hasOwn` torna isso explícito em vez de acidental.
 */
function chaveDoPapel(politica: MaxPolicy, role: string): { presente: boolean; valor: unknown } {
  const mapa = politica.byRole;
  if (!mapa || typeof mapa !== "object") return { presente: false, valor: undefined };
  const presente = Object.hasOwn(mapa, role);
  return { presente, valor: presente ? (mapa as Record<string, unknown>)[role] : undefined };
}

/**
 * A chave de papel que vale para qualquer papel sem entrada própria.
 *
 * Um papel cuja chave de política fosse o próprio `"*"` leria `byRole["*"]`
 * pelo caminho explícito — o mesmo valor que o curinga daria. Os dois
 * caminhos colapsam; não há dupla leitura nem atalho.
 */
export const CURINGA = "*";

/**
 * A política efetiva deste sujeito nesta org.
 *
 * Resolvida UMA vez por turn, no `gate`. Resolver por chamada de tool
 * multiplicaria round-trips dentro do laço do PR 6.
 *
 * `politica` ausente/nula → `[]`. É o caso da janela de deploy e o caso do
 * tenant que nunca configurou nada — os dois querem a mesma resposta.
 */
export function resolverPolitica(params: {
  politica: MaxPolicy | null | undefined;
  sujeito: Candidate;
  /**
   * A **chave de política** deste sujeito, resolvida no servidor
   * (`GET /api/agents/user-scope`) e buscada por turn.
   *
   * Deixou de ter default. Antes ela caía no `role` do próprio candidato — e
   * aquele candidato é gravado na `phone_org_choice`, que não tem TTL: o papel
   * congelava na hora da pergunta de desambiguação, e papel customizado virava
   * o literal `"custom"` para todo mundo do tenant. Ver o aviso no
   * `UserCandidate`.
   *
   * `null` é resultado NORMAL e fail-closed — telefone que não resolve, org
   * fora do ar, membership degenerada. Resolve para NENHUMA capability, nunca
   * para um default: adivinhar aqui seria a política ALARGANDO.
   *
   * Ignorado quando `sujeito.kind === "broker"`, que não tem papel.
   */
  role: string | null;
}): Capability[] {
  const { politica, sujeito } = params;
  if (!politica) return [];

  if (sujeito.kind === "broker") {
    const base = apenasConhecidas(politica.brokerDefault);
    const mapa = politica.byRecipient;
    const over =
      mapa && typeof mapa === "object" && Object.hasOwn(mapa, sujeito.splitRecipientId)
        ? mapa[sujeito.splitRecipientId]
        : undefined;
    return aplicarOverride(base, over);
  }

  // Sem chave de papel (telefone que não resolve, membership degenerada) é
  // NENHUMA — nem o curinga. O curinga é para quem é membro e tem papel.
  const role = params.role?.trim();
  if (!role) return [];

  /**
   * Chave explícita vence — inclusive `[]`, que é a org dizendo "este papel
   * não". Só quando o papel NÃO tem entrada própria vale o curinga `"*"`.
   *
   * Por que o curinga existe (2026-09-22, decisão do Olavo): o padrão de
   * leituras vale para "usuário da plataforma, qualquer papel". Papel
   * customizado chega como `custom:<CustomRole.id>` — um id por org —, e um
   * padrão que enumerasse chaves nunca o alcançaria: justamente o estagiário
   * e o diretor da casa ficariam sem nada. `"*"` é a forma de dizer "qualquer
   * papel" sem conhecer os ids.
   *
   * Não é a política ALARGANDO por adivinhação: o `"*"` só existe se quem
   * emite a política o escreveu. Ausente, o comportamento é o de antes.
   */
  // UMA função de checagem (hasOwn em mapa válido) para os dois lookups: duas
  // cópias do mesmo guard divergiriam no primeiro ajuste, e a divergência aqui
  // é a política alargando por acidente.
  const propria = chaveDoPapel(politica, role);
  if (propria.presente) return apenasConhecidas(propria.valor);
  return apenasConhecidas(chaveDoPapel(politica, CURINGA).valor);
}


/**
 * `deny` vence `allow` — sempre, e sem exceção configurável.
 *
 * Uma negação que pudesse ser revertida por uma concessão em outro nível
 * obrigaria quem lê a política a simular a ordem de avaliação para saber o que
 * ela faz. Com `deny` soberano, a resposta a "esta pessoa pode?" é uma busca,
 * não uma simulação.
 */
function aplicarOverride(
  base: Capability[],
  over: { allow?: string[]; deny?: string[] } | undefined
): Capability[] {
  if (!over) return base;
  if (!over || typeof over !== "object") return base;
  const deny = new Set(apenasConhecidas(over.deny));
  const comAllow = new Set([...base, ...apenasConhecidas(over.allow)]);
  return [...comAllow].filter((c) => !deny.has(c));
}

/** Açúcar de leitura para os call-sites do PR 6. */
export function permite(policy: Capability[], cap: Capability): boolean {
  return policy.includes(cap);
}
