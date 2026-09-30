/**
 * Catálogo de templates da Meta: qual template cada tipo de notificação usa, e
 * como os parâmetros saem da linha do outbox.
 *
 * Por que existe: na Cloud API, fora da janela de 24h, só sai TEMPLATE
 * aprovado. O contractmaker diz QUAL notificação é (`kind`) e manda as
 * variáveis soltas (`params`); aqui isso vira `name` + lista ordenada de
 * parâmetros, que é o que a Graph API recebe.
 *
 * Os TEXTOS moram aqui e passam pela aprovação do Olavo antes de qualquer
 * submissão. A submissão à Meta é o `scripts/templates-sync.ts` (dry-run por
 * padrão); mudar um texto depois de aprovado exige resubmeter e esperar nova
 * análise.
 *
 * Regras da Meta que o catálogo respeita e que `catalog.test.ts` trava:
 *  - nenhuma variável no começo nem no fim do texto;
 *  - variáveis numeradas em sequência, sem pular;
 *  - parâmetro nunca vazio, nunca com quebra de linha.
 *
 * Botão de URL ("Abrir no ImobPro"): domínio FIXO com a variável só no fim —
 * o redirecionador `/r/<id>` deste serviço, porque o link real muda de host
 * por tenant. Só os templates da EQUIPE têm; os da parte não (`botao`).
 *
 * Régua do Olavo (29/09/2026): nenhum template financeiro — cobrança,
 * pagamento e comissão não entram aqui.
 */

export type FonteDeVariavel =
  /** Primeiro nome de quem recebe. */
  | "nome"
  /** Nome da imobiliária — um número atende vários tenants. */
  | "org"
  /** Título da notificação (curto, uma linha). */
  | "titulo"
  /** Uma chave de `params` (ex.: `negocio`, `etapa`, `prazo`). */
  | { param: string };

export interface TemplateDef {
  /** Nome do template na Meta — minúsculo, `_`, único no WABA. */
  name: string;
  lang: "pt_BR";
  category: "UTILITY";
  /** Texto com `{{1}}`, `{{2}}`… — submetido à Meta como está. */
  body: string;
  /** Uma fonte por variável, na ordem de `{{1}}`, `{{2}}`… */
  vars: FonteDeVariavel[];
  /** Exemplo por variável — a Meta exige na submissão. */
  exemplos: string[];
  /**
   * Leva o botão de URL "Abrir no ImobPro"? `false` nos templates da PARTE:
   * o cliente final não tem login nem link público — o botão dele abriria o
   * redirecionador `/r/<id>` sem destino, ou seja, um 404. Decidido no
   * catálogo (e não na hora do envio) porque o botão faz parte do template
   * APROVADO: não dá para omiti-lo numa mensagem e mandá-lo em outra.
   */
  botao: boolean;
}

/** Texto do botão de todos os templates. */
export const BOTAO_TEXTO = "Abrir no ImobPro";

/** Fallback por fonte: a Meta recusa parâmetro vazio. */
const FALLBACK: Record<string, string> = {
  nome: "cliente",
  org: "imobiliária",
  titulo: "atualização",
  negocio: "em andamento",
  etapa: "atual",
  prazo: "o prazo informado",
};

const t = (
  name: string,
  body: string,
  vars: FonteDeVariavel[],
  exemplos: string[],
  botao = true
): TemplateDef => ({ name, lang: "pt_BR", category: "UTILITY", body, vars, exemplos, botao });

/** Template da PARTE: sem botão (ver `TemplateDef.botao`). */
const tParte = (name: string, body: string, vars: FonteDeVariavel[], exemplos: string[]) =>
  t(name, body, vars, exemplos, false);

const NOME = "nome" as const;
const ORG = "org" as const;
const NEGOCIO = { param: "negocio" };
const ETAPA = { param: "etapa" };

/** Template de quem não tem um próprio — inclusive todo tipo do sino. */
export const GENERICO = t(
  "imobpro_aviso",
  "Olá, {{1}}! Você tem uma atualização na {{2}}: {{3}}. Toque no botão abaixo para ver os detalhes.",
  [NOME, ORG, "titulo"],
  ["Ana", "RE/MAX Trio", "Proposta aceita"]
);

/** `kind` → template. O que não está aqui usa o `GENERICO`. */
export const CATALOGO: Record<string, TemplateDef> = {
  stage_change: t(
    "imobpro_negocio_status",
    "Olá, {{1}}! O negócio {{2}} avançou para a etapa {{3}}. Aviso da {{4}} pelo ImobPro.",
    [NOME, NEGOCIO, ETAPA, ORG],
    ["Ana", "Venda Apto 302", "Assinatura", "RE/MAX Trio"]
  ),
  form_completed: t(
    "imobpro_formulario_concluido",
    "Olá, {{1}}! O formulário do negócio {{2}} foi preenchido até o fim e o contrato já está em geração. Aviso da {{3}} pelo ImobPro.",
    [NOME, NEGOCIO, ORG],
    ["Ana", "Venda Apto 302", "RE/MAX Trio"]
  ),
  form_reminder: t(
    "imobpro_formulario_lembrete",
    "Olá, {{1}}! O formulário do negócio {{2}} ainda não foi concluído. Se precisar, reencaminhe o link às partes. Aviso da {{3}} pelo ImobPro.",
    [NOME, NEGOCIO, ORG],
    ["Ana", "Venda Apto 302", "RE/MAX Trio"]
  ),
  form_completed_parte: tParte(
    "imobpro_formulario_concluido_parte",
    "Olá, {{1}}! O formulário do seu negócio foi preenchido até o fim. A {{2}} segue com os próximos passos e avisa você se precisar de algo.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"]
  ),
  form_reminder_parte: tParte(
    "imobpro_formulario_lembrete_parte",
    "Olá, {{1}}! O formulário do seu negócio ainda não foi concluído. A {{2}} está à disposição se precisar de ajuda para continuar.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"]
  ),
  contract_sent: t(
    "imobpro_contrato_enviado",
    "Olá, {{1}}! O contrato do negócio {{2}} foi enviado para assinatura das partes. Aviso da {{3}} pelo ImobPro.",
    [NOME, NEGOCIO, ORG],
    ["Ana", "Venda Apto 302", "RE/MAX Trio"]
  ),
  contract_signed: t(
    "imobpro_contrato_assinado",
    "Olá, {{1}}! O contrato do negócio {{2}} foi assinado por todas as partes. Aviso da {{3}} pelo ImobPro.",
    [NOME, NEGOCIO, ORG],
    ["Ana", "Venda Apto 302", "RE/MAX Trio"]
  ),
  contract_signed_parte: tParte(
    "imobpro_contrato_assinado_parte",
    "Olá, {{1}}! O contrato foi assinado por todas as partes. A {{2}} segue com os próximos passos e avisa você se precisar de algo.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"]
  ),
  deal_sla_breached: t(
    "imobpro_negocio_sla",
    "Olá, {{1}}! O negócio {{2}} passou do prazo da etapa {{3}}. Aviso da {{4}} pelo ImobPro.",
    [NOME, NEGOCIO, ETAPA, ORG],
    ["Ana", "Venda Apto 302", "Documentação", "RE/MAX Trio"]
  ),

  // ── Pedidos manuais (menu fixo do admin) ────────────────────────────────
  // Um por item de `lib/max/manual-requests.ts` do contractmaker, que manda
  // `manual_<id>` para o corretor e `manual_<id>_parte` para a parte. Item
  // novo lá exige o template aqui ANTES — sem ele, cai no genérico, que não
  // diz o que está sendo pedido.
  manual_documentos: t(
    "imobpro_pedido_documentos",
    "Olá, {{1}}! A {{2}} pede os documentos pendentes do negócio {{3}}. Toque no botão abaixo para abrir o negócio.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"]
  ),
  manual_documentos_parte: tParte(
    "imobpro_pedido_documentos_parte",
    "Olá, {{1}}! A {{2}} precisa dos documentos pendentes do seu negócio para seguir com o processo. Envie assim que possível ou fale com o seu corretor.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"]
  ),
  manual_contato: t(
    "imobpro_pedido_contato",
    "Olá, {{1}}! A administração da {{2}} pede que você entre em contato sobre o negócio {{3}}. Toque no botão abaixo para abrir o negócio.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"]
  ),
  manual_contato_parte: tParte(
    "imobpro_pedido_contato_parte",
    "Olá, {{1}}! A {{2}} precisa falar com você sobre o seu negócio. Entre em contato assim que puder.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"]
  ),
  manual_atualizacao: t(
    "imobpro_pedido_atualizacao",
    "Olá, {{1}}! A {{2}} pede uma atualização do negócio {{3}}. Toque no botão abaixo para abrir e registrar o andamento.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"]
  ),
};

/** Todos os templates, para a submissão e para os testes de regra. */
export function todosOsTemplates(): TemplateDef[] {
  return [...Object.values(CATALOGO), GENERICO];
}

export function templateDoKind(kind: string | null | undefined): TemplateDef {
  return (kind && CATALOGO[kind]) || GENERICO;
}

/** O que a linha do outbox oferece para montar os parâmetros. */
export interface LinhaParaTemplate {
  recipient_name: string;
  org_name: string;
  title: string;
  params: Record<string, string> | null;
}

/** Uma linha, curta, nunca vazia — a Meta recusa as três coisas. */
function parametro(valor: string | null | undefined, fallback: string): string {
  const limpo = (valor ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return limpo || fallback;
}

/** Parâmetros do corpo na ordem de `{{1}}`, `{{2}}`… */
export function parametrosDoCorpo(def: TemplateDef, linha: LinhaParaTemplate): string[] {
  return def.vars.map((fonte) => {
    if (fonte === "nome") {
      const primeiro = linha.recipient_name.trim().split(/\s+/)[0];
      return parametro(primeiro, FALLBACK.nome);
    }
    if (fonte === "org") return parametro(linha.org_name, FALLBACK.org);
    if (fonte === "titulo") return parametro(linha.title, FALLBACK.titulo);
    // Param ausente (emissor antigo, sem `params`) cai num fallback que ainda
    // lê bem na frase: "O negócio em andamento foi…", "…da etapa atual".
    const v = linha.params?.[fonte.param];
    return parametro(v, FALLBACK[fonte.param] ?? FALLBACK.titulo);
  });
}
