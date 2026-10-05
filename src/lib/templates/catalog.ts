/**
 * Catálogo de templates da Meta: qual template cada tipo de notificação usa, e
 * como os parâmetros saem da linha do outbox.
 *
 * Por que existe: na Cloud API, fora da janela de 24h, só sai TEMPLATE
 * aprovado. O contractmaker diz QUAL notificação é (`kind`) e manda as
 * variáveis soltas (`params`); aqui isso vira `name` + lista ordenada de
 * parâmetros, que é o que a Graph API recebe.
 *
 * ── A régua (decisão do Olavo, 01/10/2026; propostas no PR 3, 05/10/2026) ──
 * SÓ estes temas têm template: formulário finalizado, formulário pendente,
 * contrato assinado, pesquisa de satisfação, mensagem da imobiliária,
 * onboarding (boas-vindas, configuração pendente e o repasse de dúvida) e
 * proposta (assinada, recusada, expirada, entregue). Nenhum texto cita o nome
 * do sistema. Tudo o mais é FORA DA RÉGUA: sai como texto livre dentro da
 * janela de 24h e, fora dela, não sai pelo WhatsApp (`templateDoKind` devolve
 * `null` e o outbox desiste). Não existe mais template genérico — ele fazia
 * qualquer aviso virar mensagem paga.
 *
 * ── Nomes ────────────────────────────────────────────────────────────────
 * Prefixo `max_`: o WABA é COMPARTILHADO com o app da própria FINCasa, e um
 * nome genérico (`boas_vindas`) pode colidir com um template dela. O nome
 * nunca aparece para quem recebe.
 *
 * Os TEXTOS passam pela aprovação do Olavo antes de qualquer submissão
 * (`scripts/templates-sync.ts`, dry-run por padrão); mudar um texto depois
 * de aprovado exige resubmeter e esperar nova análise.
 *
 * Regras da Meta que o catálogo respeita e que `catalog.test.ts` trava:
 *  - nenhuma variável no começo nem no fim do texto;
 *  - variáveis numeradas em sequência, sem pular;
 *  - parâmetro nunca vazio, nunca com quebra de linha.
 */

export type FonteDeVariavel =
  /** Primeiro nome de quem recebe. */
  | "nome"
  /** Nome da imobiliária — um número atende vários tenants. */
  | "org"
  /** Título da notificação (curto, uma linha). */
  | "titulo"
  /** Uma chave de `params` (ex.: `negocio`, `quem`). */
  | { param: string };

/**
 * Ações dos botões de AÇÃO (`acoes`/`acao_e_url`, PR 3) — enum FECHADO porque
 * vira parte do payload que volta no webhook (`acao:<id>:<ação>`) e é o que
 * `lib/aceite.ts` usa para decidir se pode responder. A ação de verdade
 * (converter a proposta, recriá-la) é o PR 6; aqui só o botão e o roteamento.
 */
export type AcaoBotao = "converter" | "agora_nao" | "recriar";

/** Um botão de resposta rápida de AÇÃO: texto visível + a ação do enum. */
export interface AcaoItem {
  texto: string;
  acao: AcaoBotao;
}

/**
 * Botões do template — fazem parte do template APROVADO, então são decididos
 * aqui e não na hora do envio.
 *
 *  · `url`: "abrir" com domínio fixo e a variável no fim — o redirecionador
 *    `/r/<id>` deste serviço, porque o link real muda de host por tenant. Só
 *    onde existe destino: a parte não tem login, então template de parte só
 *    leva URL quando o destino é público (o formulário, a pesquisa).
 *  · `ok`: resposta rápida. O toque volta no webhook com o payload
 *    `ok:<id da linha>`, e o Max entrega o texto guardado (`lib/aceite.ts`).
 *  · `url_e_ok`: os dois — o de resposta rápida aqui é "Tenho uma dúvida"
 *    (payload `duvida:<id>`), que abre o repasse ao time.
 *  · `acoes`: até 2 respostas rápidas de AÇÃO (ex.: "Converter em negócio" /
 *    "Agora não") — o toque volta como `acao:<id>:<ação>` (`lib/aceite.ts`).
 *  · `acao_e_url`: uma ação + um botão de URL (ex.: "Recriar proposta" +
 *    "Abrir proposta") — mesma regra de URL do `url` acima.
 */
export type Botao =
  | { tipo: "url"; texto: string }
  | { tipo: "ok"; texto: string }
  | { tipo: "url_e_ok"; texto: string; ok: string }
  | { tipo: "acoes"; acoes: [AcaoItem, AcaoItem] }
  | { tipo: "acao_e_url"; acao: AcaoItem; urlTexto: string };

/**
 * Os botões do template NA ORDEM em que a Meta os indexa (0, 1…). Fonte
 * única da ordem: a submissão (`scripts/templates-sync.ts`) e o envio
 * (`botoesDaLinha` no outbox) derivam daqui — um descasamento entre os dois
 * é recusado na hora do envio (132000).
 */
export type BotaoOrdenado =
  | { tipo: "url"; texto: string }
  | { tipo: "quick_reply"; texto: string; prefixo: "ok" | "duvida" }
  | { tipo: "quick_reply_acao"; texto: string; acao: AcaoBotao };

export function botoesEmOrdem(botao: Botao | null): BotaoOrdenado[] {
  if (!botao) return [];
  if (botao.tipo === "url") return [{ tipo: "url", texto: botao.texto }];
  if (botao.tipo === "ok") return [{ tipo: "quick_reply", texto: botao.texto, prefixo: "ok" }];
  if (botao.tipo === "url_e_ok")
    return [
      { tipo: "url", texto: botao.texto },
      { tipo: "quick_reply", texto: botao.ok, prefixo: "duvida" },
    ];
  if (botao.tipo === "acoes")
    return botao.acoes.map((a) => ({ tipo: "quick_reply_acao", texto: a.texto, acao: a.acao }));
  // `acao_e_url`: URL primeiro, ação (resposta rápida) depois — mesma regra
  // da Meta que o `url_e_ok` já segue (call-to-action antes de quick reply;
  // misturar na ordem errada é recusado na submissão).
  return [
    { tipo: "url", texto: botao.urlTexto },
    { tipo: "quick_reply_acao", texto: botao.acao.texto, acao: botao.acao.acao },
  ];
}

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
  botao: Botao | null;
  /**
   * Params (chaves de `linha.params`) que precisam estar presentes e NÃO
   * vazios para este template poder ser usado (ver `templateUsavel`).
   * Ausente/`[]` = comportamento antigo: falta vira o `FALLBACK` abaixo.
   * Existe porque o mesmo `{ param: X }` genérico serve a dois mundos — o
   * `negocio`/`quem` antigos, que sempre tiveram fallback, e o `proposta`/
   * `quem` dos templates de proposta (PR 3), onde um fallback tipo "a
   * proposta em andamento foi assinada" seria pior que não enviar.
   */
  paramsObrigatorios?: string[];
}

/** Fallback por fonte: a Meta recusa parâmetro vazio. */
const FALLBACK: Record<string, string> = {
  nome: "cliente",
  org: "imobiliária",
  titulo: "atualização",
  negocio: "em andamento",
  quem: "Um cliente",
};

const t = (
  name: string,
  body: string,
  vars: FonteDeVariavel[],
  exemplos: string[],
  botao: Botao | null,
  paramsObrigatorios?: string[]
): TemplateDef => ({
  name,
  lang: "pt_BR",
  category: "UTILITY",
  body,
  vars,
  exemplos,
  botao,
  ...(paramsObrigatorios && paramsObrigatorios.length > 0 ? { paramsObrigatorios } : {}),
});

const NOME = "nome" as const;
const ORG = "org" as const;
const NEGOCIO = { param: "negocio" };
const PROPOSTA = { param: "proposta" };
const QUEM = { param: "quem" };

const ABRIR_NEGOCIO: Botao = { tipo: "url", texto: "Abrir negócio" };
const OK: Botao = { tipo: "ok", texto: "OK" };

const CONVERTER: AcaoItem = { texto: "Converter em negócio", acao: "converter" };
const AGORA_NAO: AcaoItem = { texto: "Agora não", acao: "agora_nao" };
const RECRIAR: AcaoItem = { texto: "Recriar proposta", acao: "recriar" };

const PESQUISA = t(
  "max_pesquisa_satisfacao",
  "Olá, {{1}}! A {{2}} quer saber como está sendo sua experiência até agora. É uma pergunta só e leva menos de um minuto.",
  [NOME, ORG],
  ["Carlos", "RE/MAX Trio"],
  { tipo: "url", texto: "Responder" }
);

const MENSAGEM = t(
  "max_mensagem_imobiliaria",
  "Olá, {{1}}! A {{2}} tem uma mensagem para você. Responda OK ou toque no botão abaixo para ver.",
  [NOME, ORG],
  ["Carlos", "RE/MAX Trio"],
  OK
);

/**
 * `kind` → template. O que não está aqui é FORA DA RÉGUA (ver o topo).
 *
 * Mesma convenção do contractmaker: a versão da PARTE leva `_parte`. Pesquisa
 * e mensagem da imobiliária usam o MESMO template para os dois públicos — o
 * texto não tem jargão interno.
 */
export const CATALOGO: Record<string, TemplateDef> = {
  form_completed: t(
    "max_formulario_concluido",
    "Olá, {{1}}! A {{2}} avisa: o formulário do negócio {{3}} foi preenchido até o fim. Toque no botão abaixo para abrir o negócio.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  form_completed_parte: t(
    "max_formulario_concluido_parte",
    "Olá, {{1}}! O formulário do seu negócio foi preenchido até o fim. A {{2}} segue com os próximos passos e avisa você se precisar de algo.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    null
  ),
  form_reminder: t(
    "max_formulario_pendente",
    "Olá, {{1}}! A {{2}} avisa: o formulário do negócio {{3}} ainda não foi concluído. Toque no botão abaixo para abrir o negócio e reenviar o link às partes.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  form_reminder_parte: t(
    "max_formulario_pendente_parte",
    "Olá, {{1}}! O formulário do seu negócio com a {{2}} ainda não foi concluído. Toque no botão abaixo para continuar de onde parou.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    // O destino é o link PÚBLICO do formulário — a parte não precisa de login.
    { tipo: "url", texto: "Continuar formulário" }
  ),
  contract_signed: t(
    "max_contrato_assinado",
    "Olá, {{1}}! A {{2}} avisa: o contrato do negócio {{3}} foi assinado por todas as partes. Toque no botão abaixo para abrir o negócio.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  contract_signed_parte: t(
    "max_contrato_assinado_parte",
    "Olá, {{1}}! O contrato foi assinado por todas as partes. A {{2}} segue com os próximos passos e avisa você se precisar de algo.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    null
  ),
  survey_invite: PESQUISA,
  survey_invite_parte: PESQUISA,
  manual_message: MENSAGEM,
  manual_message_parte: MENSAGEM,
  welcome: t(
    "max_boas_vindas",
    "Olá, {{1}}! Eu sou o Max, o assistente da {{2}} no WhatsApp. É por aqui que você vai receber as notificações dos negócios: formulários, contratos e o que precisar da sua atenção. Para começar, toque no botão abaixo e faça o seu primeiro acesso ao sistema. Se quiser saber o que mais posso fazer, é só perguntar.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url", texto: "Fazer primeiro acesso" }
  ),
  onboarding_pending: t(
    "max_configuracao_pendente",
    "Olá, {{1}}! A configuração da {{2}} ainda não foi concluída. Toque no botão abaixo para continuar de onde parou. Se ficou alguma dúvida, toque em \"Tenho uma dúvida\" e me conte: eu passo direto para a nossa equipe.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url_e_ok", texto: "Continuar configuração", ok: "Tenho uma dúvida" }
  ),
  /** O repasse da dúvida para o time (ver `lib/aceite.ts`). */
  support_handoff: t(
    "max_duvida_de_cliente",
    "Olá, {{1}}! {{2}}, da {{3}}, mandou uma dúvida sobre a configuração do sistema. Responda OK ou toque no botão abaixo para ver a mensagem.",
    [NOME, { param: "quem" }, ORG],
    ["Olavo", "Ana Souza", "RE/MAX Trio"],
    OK
  ),
  /**
   * ── Propostas (PR 3, decisão do Olavo, 05/10/2026) ───────────────────────
   * `proposta`/`quem` são OBRIGATÓRIOS (`paramsObrigatorios`): o contractmaker
   * ainda não manda essas chaves (vai mandar num PR separado) — sem elas a
   * linha não sai por ESTE template, nunca com um fallback genérico tipo "a
   * proposta em andamento" (ver `templateUsavel`). A ação de verdade por
   * trás dos botões (converter, recriar) é o PR 6; aqui só o botão e o texto
   * fixo de resposta (`lib/aceite.ts`).
   */
  proposal_completed: t(
    "max_proposta_assinada",
    "Olá, {{1}}! A proposta {{2}}, da {{3}}, foi assinada por todos os signatários. Escolha abaixo se quer converter a proposta em negócio agora.",
    [NOME, PROPOSTA, ORG],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"],
    { tipo: "acoes", acoes: [CONVERTER, AGORA_NAO] },
    ["proposta"]
  ),
  // {{4}} vem com a preposição contraída ("pelo proponente"/"pelo
  // proprietário") — decisão do Olavo, 05/10/2026.
  proposal_refused: t(
    "max_proposta_recusada",
    "Olá, {{1}}! A proposta {{2}}, da {{3}}, foi recusada {{4}}. Você pode recriar a proposta com os mesmos dados pelo botão abaixo.",
    [NOME, PROPOSTA, ORG, QUEM],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio", "pelo proprietário"],
    { tipo: "acao_e_url", acao: RECRIAR, urlTexto: "Abrir proposta" },
    ["proposta", "quem"]
  ),
  proposal_expired: t(
    "max_proposta_expirada",
    "Olá, {{1}}! O prazo de assinatura da proposta {{2}}, da {{3}}, venceu sem todas as assinaturas. Você pode recriar a proposta com os mesmos dados pelo botão abaixo.",
    [NOME, PROPOSTA, ORG],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"],
    { tipo: "acao_e_url", acao: RECRIAR, urlTexto: "Abrir proposta" },
    ["proposta"]
  ),
  // {{4}} vem com a preposição contraída ("ao proponente"/"ao
  // proprietário") — decisão do Olavo, 05/10/2026.
  proposal_delivered: t(
    "max_proposta_entregue",
    "Olá, {{1}}! A proposta {{2}}, da {{3}}, foi entregue {{4}} para assinatura. Acompanhe o andamento pelo botão abaixo.",
    [NOME, PROPOSTA, ORG, QUEM],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio", "ao proprietário"],
    { tipo: "url", texto: "Abrir proposta" },
    ["proposta", "quem"]
  ),
};

/**
 * Kinds cujo texto (`outbox.body`) só é entregue depois do OK — quando saem
 * por template. Mora aqui, e não em `lib/aceite.ts`, porque o outbox também
 * precisa dela e o aceite importa o outbox.
 */
export const KINDS_COM_ACEITE: readonly string[] = [
  "manual_message",
  "manual_message_parte",
  "support_handoff",
];

/**
 * Versão 2 — texto estritamente TRANSACIONAL (decisão do Olavo, 03/10/2026).
 *
 * Em 03/10 a Meta reclassificou 7 dos 11 templates de UTILITY para MARKETING
 * (`previous_category: UTILITY`): mais caro, sujeito ao limite de frequência
 * por pessoa (erro 131049, visto em produção) e com opção de descadastro. O
 * v2 diz o fato da transação da pessoa e a ação — sem apresentação, convite
 * ou suspense. A apresentação do Max saiu do template de boas-vindas e vai
 * como texto livre na primeira resposta da pessoa (`lib/aceite.ts`).
 *
 * Mesmas variáveis e botões do v1. O envio escolhe entre as versões
 * aprovadas (`templatesDoKind` + `outbox.ts`): nada fica mudo enquanto a Meta
 * analisa uma versão nova.
 */
const V2: Record<string, TemplateDef> = {
  form_completed: t(
    "max_formulario_concluido_v2",
    "Olá, {{1}}! Formulário concluído na {{2}}: o negócio {{3}} já tem todas as respostas das partes. Toque no botão abaixo para abrir o negócio.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  form_reminder: t(
    "max_formulario_pendente_v2",
    "Olá, {{1}}! Formulário incompleto na {{2}}: o negócio {{3}} ainda tem respostas pendentes das partes. Toque no botão abaixo para abrir o negócio e reenviar o link.",
    [NOME, ORG, NEGOCIO],
    ["Ana", "RE/MAX Trio", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  form_reminder_parte: t(
    "max_formulario_pendente_parte_v2",
    "Olá, {{1}}! O formulário do seu negócio com a {{2}} está incompleto. Toque no botão abaixo para continuar o preenchimento.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    { tipo: "url", texto: "Continuar formulário" }
  ),
  welcome: t(
    "max_boas_vindas_v2",
    "Olá, {{1}}! Seu acesso à {{2}} foi aprovado. Toque no botão abaixo para criar sua senha de primeiro acesso. As notificações dos seus negócios chegarão por este número.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url", texto: "Fazer primeiro acesso" }
  ),
  onboarding_pending: t(
    "max_configuracao_pendente_v2",
    "Olá, {{1}}! A configuração inicial da {{2}} ainda não foi concluída. Toque em \"Continuar configuração\" para concluir. Se tiver dúvida sobre a configuração, toque em \"Tenho uma dúvida\".",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url_e_ok", texto: "Continuar configuração", ok: "Tenho uma dúvida" }
  ),
  support_handoff: t(
    "max_duvida_de_cliente_v2",
    "Olá, {{1}}! Nova dúvida de configuração recebida de {{2}}, da {{3}}. Responda OK para ver a dúvida.",
    [NOME, { param: "quem" }, ORG],
    ["Olavo", "Ana Souza", "RE/MAX Trio"],
    OK
  ),
};
const MENSAGEM_V2 = t(
  "max_mensagem_imobiliaria_v2",
  "Olá, {{1}}! A {{2}} enviou uma mensagem sobre o seu negócio. Responda OK para recebê-la aqui.",
  [NOME, ORG],
  ["Carlos", "RE/MAX Trio"],
  OK
);
V2.manual_message = MENSAGEM_V2;
V2.manual_message_parte = MENSAGEM_V2;

/**
 * Versão 3 — texto de STATUS da transação (decisão do Olavo, 03/10/2026).
 *
 * Na análise dos v2 (03/10) a Meta deu UTILITY às boas-vindas e ao formulário
 * concluído, mas manteve MARKETING nos lembretes ("ainda", "incompleto",
 * "continue") e na mensagem que só avisa que existe ("responda OK"). O v3
 * escreve como os aprovados: status de um negócio/conta em andamento + onde
 * está o detalhe. Mesmas variáveis (a ordem pode mudar) e botões do v1.
 */
const V3: Record<string, TemplateDef> = {
  form_reminder: t(
    "max_formulario_pendente_v3",
    "Olá, {{1}}! Status do negócio {{2}} na {{3}}: formulário com respostas pendentes das partes. Detalhes e link de reenvio no botão abaixo.",
    // A Meta exige {{1}}, {{2}}, {{3}} em sequência no texto: a ordem das
    // variáveis muda em relação ao v1, os parâmetros saem desta lista.
    [NOME, NEGOCIO, ORG],
    ["Ana", "Venda Apto 302", "RE/MAX Trio"],
    ABRIR_NEGOCIO
  ),
  form_reminder_parte: t(
    "max_formulario_pendente_parte_v3",
    "Olá, {{1}}! Status do seu formulário com a {{2}}: preenchimento em aberto. O formulário está disponível no botão abaixo.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    { tipo: "url", texto: "Continuar formulário" }
  ),
  onboarding_pending: t(
    "max_configuracao_pendente_v3",
    "Olá, {{1}}! Status da conta da {{2}}: configuração inicial em aberto. Para acessar a configuração, use o botão \"Continuar configuração\". Para enviar uma dúvida, use \"Tenho uma dúvida\".",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url_e_ok", texto: "Continuar configuração", ok: "Tenho uma dúvida" }
  ),
};
const MENSAGEM_V3 = t(
  "max_mensagem_imobiliaria_v3",
  "Olá, {{1}}! A {{2}} registrou uma mensagem referente ao seu negócio em andamento. Responda OK para receber o conteúdo da mensagem nesta conversa.",
  [NOME, ORG],
  ["Carlos", "RE/MAX Trio"],
  OK
);
V3.manual_message = MENSAGEM_V3;
V3.manual_message_parte = MENSAGEM_V3;

/**
 * Versão 4 — só do `welcome` (decisão do Olavo, 05/10/2026). Troca a
 * apresentação por uma instrução de AGENDA ("salve este número como Max"):
 * diz quem está falando sem reintroduzir o texto que levou o v1 a MARKETING.
 * Botão novo ("Criar senha" — não repete o texto do v1/v2/v3); mesmas
 * variáveis ([NOME, ORG]).
 */
const V4: Record<string, TemplateDef> = {
  welcome: t(
    "max_boas_vindas_v4",
    "Olá, {{1}}! Seu acesso à {{2}} foi aprovado. Salve este número na sua agenda como Max: é por ele que chegam os avisos dos seus negócios e propostas. Toque no botão abaixo para criar sua senha.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url", texto: "Criar senha" }
  ),
};

/** Todos os templates (sem repetição, todas as versões), para a submissão, o refresh e os testes de regra. */
export function todosOsTemplates(): TemplateDef[] {
  return [
    ...new Map(
      [...Object.values(CATALOGO), ...Object.values(V2), ...Object.values(V3), ...Object.values(V4)].map((d) => [
        d.name,
        d,
      ])
    ).values(),
  ];
}

/**
 * Os templates do `kind` em ordem de preferência — a versão mais nova primeiro
 * ([v4, v3, v2, v1], pulando as versões que esse `kind` não tem) —, ou `[]`
 * quando o tipo está FORA DA RÉGUA. O envio usa o aprovado, de preferência
 * não MARKETING (`outbox.ts`).
 */
export function templatesDoKind(kind: string | null | undefined): TemplateDef[] {
  if (!kind || !CATALOGO[kind]) return [];
  return [V4[kind], V3[kind], V2[kind], CATALOGO[kind]].filter((d): d is TemplateDef => !!d);
}

/** O template preferido do `kind`, ou `null` quando o tipo está FORA DA RÉGUA. */
export function templateDoKind(kind: string | null | undefined): TemplateDef | null {
  return templatesDoKind(kind)[0] ?? null;
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

/**
 * Falso quando `def.paramsObrigatorios` tem alguma chave ausente ou vazia em
 * `linha.params` — este candidato NÃO pode ser usado para esta linha, nunca
 * com o `FALLBACK` (ver o comentário do campo em `TemplateDef`). Quem decide
 * o template a usar (`outbox.ts`) filtra os candidatos por isto ANTES de
 * checar aprovação da Meta — um template sem o parâmetro obrigatório não
 * entra na disputa por "o aprovado", mesmo que esteja `APPROVED`.
 */
export function templateUsavel(def: TemplateDef, linha: LinhaParaTemplate): boolean {
  if (!def.paramsObrigatorios || def.paramsObrigatorios.length === 0) return true;
  return def.paramsObrigatorios.every((chave) => !!linha.params?.[chave]?.trim());
}

/** O primeiro parâmetro obrigatório que falta nesta linha, ou `null`. */
export function parametroObrigatorioFaltando(def: TemplateDef, linha: LinhaParaTemplate): string | null {
  return def.paramsObrigatorios?.find((chave) => !linha.params?.[chave]?.trim()) ?? null;
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
