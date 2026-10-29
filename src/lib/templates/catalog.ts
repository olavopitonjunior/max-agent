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
 * proposta (assinada, recusada, expirada, entregue) e, desde 14/10/2026
 * (decisão do Olavo, atividades agendadas), um aviso NEUTRO de atividades
 * pendentes (`activity_assigned`, `activity_due` e `activity_due_soon`, mesmo
 * template, um por janela; `activity_completed` fica fora) e, desde 20/10/2026 (pedido do
 * Olavo), o aviso de novidade no link do cliente do portal do negócio
 * (`portal_notice_parte`) e, desde 25/10/2026, SEIS templates de "família" para
 * os avisos da equipe que antes morriam em silêncio com a janela fechada
 * (`fora_da_regua`: 54 de 126 notificações em 30 dias): assinatura de
 * envelope, status de proposta, andamento do negócio, andamento de formulário
 * e certidões (pendência e lote concluído) — ver `FAMILIAS` abaixo. Andamento
 * de atividade (`activity_completed` etc.) continua FORA, pela decisão de 14/10.
 * Nenhum texto cita o nome do sistema. Tudo o mais é FORA DA RÉGUA: sai como texto livre dentro da
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

import type { AcaoAviso, Aviso } from "../aviso/schema";

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
  | { tipo: "acao_e_url"; acao: AcaoItem; urlTexto: string }
  | { tipo: "respostas"; respostas: RespostaAviso[] };

/**
 * Uma resposta rápida do AVISO (M9, família V5): texto visível + a ação do
 * contrato `aviso`. O toque volta como `av:<id da linha>:<ação>` e é tratado
 * por `lib/aviso-botao.ts` (M6), o mesmo roteador dos botões dentro da janela.
 * O texto de botão de template não leva emoji e fica em até 20 caracteres
 * (`catalog.test.ts` e `templates-v5.test.ts` travam as duas regras).
 */
export interface RespostaAviso {
  texto: string;
  acao: AcaoAviso;
}

/**
 * Os botões do template NA ORDEM em que a Meta os indexa (0, 1…). Fonte
 * única da ordem: a submissão (`scripts/templates-sync.ts`) e o envio
 * (`botoesDaLinha` no outbox) derivam daqui — um descasamento entre os dois
 * é recusado na hora do envio (132000).
 */
export type BotaoOrdenado =
  | { tipo: "url"; texto: string }
  | { tipo: "quick_reply"; texto: string; prefixo: "ok" | "duvida" }
  | { tipo: "quick_reply_acao"; texto: string; acao: AcaoBotao }
  | { tipo: "quick_reply_aviso"; texto: string; acao: AcaoAviso };

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
  if (botao.tipo === "respostas")
    return botao.respostas.map((r) => ({ tipo: "quick_reply_aviso", texto: r.texto, acao: r.acao }));
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
   * Cabeçalho do template (M9). Só `imagem`: o link vem de `aviso.imagemUrl`
   * na hora do envio (`outbox.ts`) e o template só é usável com ele
   * (`templateUsavel`). A Meta pede uma imagem de EXEMPLO na submissão
   * (`header_handle`, upload), por isso o `templates-sync` PULA estes templates
   * e quem submete é o Gerenciador (`docs/templates-v5-para-submeter.md`).
   */
  cabecalho?: { tipo: "imagem" };
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
  /**
   * Aviso neutro de "um por janela" (atividades pendentes, 14/10/2026): fora
   * da janela de 24h, o outbox manda este template só para a PRIMEIRA linha
   * do telefone; as seguintes viram `dropped` até a pessoa escrever de novo
   * ou 24h passarem do último aviso (`lib/atividades-pendentes.ts`).
   */
  umPorJanela?: boolean;
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
const VER_ATIVIDADES: Botao = { tipo: "url", texto: "Ver atividades" };
/** Mesmo rótulo do v1, mas resposta rápida `ok`: o toque traz a lista para o chat (`lib/aceite.ts`). */
const VER_ATIVIDADES_OK: Botao = { tipo: "ok", texto: "Ver atividades" };

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
 * Atividades agendadas: UM texto neutro para `activity_assigned` e
 * `activity_due`. Não carrega dado da atividade (atividade, negócio, quando,
 * recado ficam no texto livre da janela aberta, no e-mail e no sino): o
 * catálogo não tem parâmetro opcional e o aviso é "tem coisa esperando você".
 * O botão abre o `linkUrl` da linha que o disparou (`/r/<id>`), a página
 * `/atividades?a=<id>` do contractmaker, que lista tudo. O TEXTO foi aprovado
 * pelo Olavo em 14/10/2026.
 */
const ATIVIDADES_PENDENTES: TemplateDef = {
  ...t(
    "max_atividades_pendentes",
    "Olá, {{1}}! Você tem atividades pendentes na {{2}}. Toque no botão abaixo para ver.",
    [NOME, ORG],
    ["Carlos", "RE/MAX Trio"],
    VER_ATIVIDADES
  ),
  umPorJanela: true,
};

/**
 * Portal do negócio (20/10/2026, pedido do Olavo): aviso à PARTE de que há
 * novidade no link de acompanhamento dela (resposta da equipe, nova versão do
 * contrato, tarefa, documento, recado). O contractmaker manda o FATO só no
 * texto livre da janela aberta; o template não carrega nenhum dado do
 * negócio — nem `negocio`, cujo fallback "seu negócio" não cabe numa frase.
 * Texto de STATUS, no molde dos v3 que a Meta deu como UTILITY. O botão abre
 * o `linkUrl` da linha (`/r/<id>`): o link do portal, que pede o código por
 * e-mail, então saber o link não dá acesso. Sem botão de resposta: a parte
 * não conversa com o Max (decisão de 13/10) e responde pelo próprio link.
 */
const PORTAL_AVISO_PARTE = t(
  "max_portal_aviso_parte",
  "Olá, {{1}}! Status do seu negócio com a {{2}}: nova atualização no acompanhamento. Os detalhes e o espaço para responder estão no botão abaixo.",
  [NOME, ORG],
  ["Carlos", "RE/MAX Trio"],
  { tipo: "url", texto: "Ver atualização" }
);

/**
 * ── Famílias de avisos da equipe (25/10/2026) ──────────────────────────────
 * Antes destes, os kinds abaixo não tinham template: com a janela de 24h
 * fechada o outbox gravava `fora_da_regua` e o aviso se perdia (54 de 126 no
 * último mês). Em vez de um template por kind, UM por família — texto fixo de
 * STATUS (o molde dos v3 que a Meta deu como UTILITY: "Status do negócio…"),
 * com poucas variáveis e o detalhe no botão. Sem tom de lembrete/convite
 * ("ainda", "incompleto", "continue"), que é o que levou outros à MARKETING.
 *
 * O que cada família consegue usar, porque é só isso que o contractmaker manda:
 *  · avisos do sino (`Notification.type`, via `user-channels.ts`) chegam SEM
 *    `params`: só o título (fixo, do sistema), a org, o nome e o link. Por isso
 *    `proposta`/`quem` NÃO são obrigatórios aqui (ao contrário dos
 *    `proposal_*` da régua de propostas) — não há de onde tirar;
 *  · avisos de evento do negócio (`stage_change`, `contract_sent`,
 *    `portal_comment`) trazem `negocio`;
 *    sem ele cai no fallback "em andamento".
 * Nada de dado da parte: o título é texto do sistema ("Contrato assinado",
 * "Status do negócio atualizado"), nunca o nome do cliente. Certidões NÃO
 * levam o título de propósito — o rótulo da certidão pode trazer o nome de
 * alguém.
 *
 * O envio continua só depois de `wa_template` dizer APPROVED (o portão do
 * outbox não mudou). Enquanto a Meta analisa, o aviso fica `template_pendente`
 * e expira em 72h, como qualquer outro template novo.
 */
const FAMILIAS = {
  /** envelope_signed / envelope_refused / envelope_email_failed. Título: "Contrato assinado", "Assinatura recusada"… */
  assinatura: t(
    "max_assinatura_status",
    "Olá, {{1}}! Status de assinatura na {{2}}: {{3}}. Os detalhes do documento estão no botão abaixo.",
    [NOME, ORG, "titulo"],
    ["Ana", "RE/MAX Trio", "Contrato assinado"],
    ABRIR_NEGOCIO
  ),
  /** proposal_accepted_party / send_canceled / aceite_not_delivered / email_failed. Título: "Envio da proposta cancelado"… */
  proposta: t(
    "max_proposta_status",
    "Olá, {{1}}! Status de proposta na {{2}}: {{3}}. Os detalhes estão no botão abaixo.",
    [NOME, ORG, "titulo"],
    ["Ana", "RE/MAX Trio", "Envio da proposta cancelado"],
    { tipo: "url", texto: "Abrir proposta" }
  ),
  /** stage_change / contract_sent / portal_comment (+ gêmeos `deal_*`). Título: "Status do negócio atualizado"… */
  negocio: t(
    "max_negocio_andamento",
    "Olá, {{1}}! Andamento de negócio na {{2}}: {{3}}. Negócio: {{4}}. Os detalhes estão no botão abaixo.",
    [NOME, ORG, "titulo", NEGOCIO],
    ["Ana", "RE/MAX Trio", "Status do negócio atualizado", "Venda Apto 302"],
    ABRIR_NEGOCIO
  ),
  /**
   * participant_completed. Título: "<papel> preencheu os dados". O papel é o
   * rótulo da categoria que a org configura — NUNCA o nome da pessoa; se o
   * contractmaker passar a mandar nome aqui, esta família tem de largar o título.
   */
  formulario: t(
    "max_formulario_andamento",
    "Olá, {{1}}! Andamento de formulário na {{2}}: {{3}}. Os detalhes estão no botão abaixo.",
    [NOME, ORG, "titulo"],
    ["Ana", "RE/MAX Trio", "Comprador preencheu os dados"],
    { tipo: "url", texto: "Abrir formulário" }
  ),
  /** certidao_problem. Texto fixo: o rótulo da certidão pode trazer nome de pessoa. */
  certidaoAtencao: t(
    "max_certidao_atencao",
    "Olá, {{1}}! Status de certidões na {{2}}: uma certidão do relatório precisa de atenção. Os detalhes estão no botão abaixo.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url", texto: "Abrir relatório" }
  ),
  /** certidao_batch_complete. Texto fixo, pelo mesmo motivo. */
  certidoesConcluidas: t(
    "max_certidoes_concluidas",
    "Olá, {{1}}! Status de certidões na {{2}}: o lote de certidões solicitado foi concluído. Os detalhes estão no botão abaixo.",
    [NOME, ORG],
    ["Ana", "RE/MAX Trio"],
    { tipo: "url", texto: "Abrir relatório" }
  ),
};

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
  // Retorno solicitado em 07/10/2026. Textos de `max_proposta_enviada` e
  // `max_proposta_assinada_proponente` aprovados pelo Olavo em 14/10/2026.
  // O catálogo não submete à Meta; quem submete é `templates-sync --apply`.
  proposal_sent: t(
    "max_proposta_enviada",
    "Olá, {{1}}! A proposta {{2}}, da {{3}}, foi enviada para assinatura. Acompanhe o andamento pelo botão abaixo.",
    [NOME, PROPOSTA, ORG],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"],
    { tipo: "url", texto: "Abrir proposta" },
    ["proposta"]
  ),
  proposal_signed_proponente: t(
    "max_proposta_assinada_proponente",
    "Olá, {{1}}! O proponente assinou a proposta {{2}}, da {{3}}. A assinatura está registrada; consulte os próximos passos pelo botão abaixo.",
    [NOME, PROPOSTA, ORG],
    ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"],
    { tipo: "url", texto: "Abrir proposta" },
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
  // Atividades agendadas (14/10/2026): mesmo template para os dois avisos.
  activity_assigned: ATIVIDADES_PENDENTES,
  activity_due: ATIVIDADES_PENDENTES,
  // Lembrete antes do prazo (pendências, 24/10/2026): o mesmo aviso neutro, fora
  // da janela. Dentro dela (e no Newton) sai o texto completo do emissor.
  activity_due_soon: ATIVIDADES_PENDENTES,
  portal_notice_parte: PORTAL_AVISO_PARTE,
};

// Crédito Upestate (M3): o aviso `credit_result` não ganha template novo na
// Meta — fora da janela sai pelo da mensagem da imobiliária (já aprovado) e o
// texto (`textoDoAvisoDeCredito`) é entregue no OK, como a mensagem manual.
CATALOGO.credit_result = MENSAGEM;

// Famílias de avisos da equipe (25/10/2026, ver `FAMILIAS`). Os gêmeos `deal_*`
// são o mesmo fato pelo caminho do sino (sem `params`); os sem prefixo, pelo
// motor de eventos do negócio (com `negocio`).
// Status por papel (27/10/2026): o responsável vai no título que o CM manda;
// template próprio `_status` só depois da aprovação do Olavo/Meta. O
// `captacao_signed_status` NÃO é mapeado: fica fora da régua (texto livre só
// dentro da janela de 24h).
for (const kind of ["envelope_signed", "envelope_refused", "envelope_email_failed", "contract_signed_status"]) CATALOGO[kind] = FAMILIAS.assinatura;
for (const kind of [
  "proposal_accepted_party",
  "proposal_send_canceled",
  "proposal_aceite_not_delivered",
  "proposal_email_failed",
  "proposal_created_status",
  "proposal_decision_status",
])
  CATALOGO[kind] = FAMILIAS.proposta;
for (const kind of [
  "stage_change",
  "deal_stage_change",
  "contract_sent",
  "deal_contract_sent",
  "portal_comment",
  "deal_portal_comment",
])
  CATALOGO[kind] = FAMILIAS.negocio;
CATALOGO.participant_completed = FAMILIAS.formulario;
CATALOGO.certidao_problem = FAMILIAS.certidaoAtencao;
CATALOGO.certidao_batch_complete = FAMILIAS.certidoesConcluidas;

// Sem vendedor cadastrado, a assinatura do proponente NÃO significa que
// todos assinaram. O mesmo fato usa o template parcial, nunca completed.
CATALOGO.proposal_awaiting_decision = CATALOGO.proposal_signed_proponente;

// Lembrete de formulário pelo caminho do sino (`deal_form_reminder`, 2 falhas
// `fora_da_regua` em 30 dias): é o MESMO fato do `form_reminder` — reaproveita
// todas as versões já aprovadas (v1/v2/v3), sem template novo. Sem `negocio` no
// sino, o texto cai no fallback "em andamento". As versões de V2/V3 são
// ligadas logo depois da definição delas.
CATALOGO.deal_form_reminder = CATALOGO.form_reminder;

/**
 * Kinds cujo texto (`outbox.body`) só é entregue depois do OK — quando saem
 * por template. Mora aqui, e não em `lib/aceite.ts`, porque o outbox também
 * precisa dela e o aceite importa o outbox.
 */
export const KINDS_COM_ACEITE: readonly string[] = [
  "manual_message",
  "manual_message_parte",
  "support_handoff",
  "credit_result",
];

/**
 * Avisos de atividade (`activity_*`): NÃO entram em `KINDS_COM_ACEITE`, porque
 * o v1 (`max_atividades_pendentes`, botão de URL) não tem botão `ok` — não há
 * o que o toque libere, e o texto dele sempre foi semeado no thread. Só a
 * linha que saiu pelo v2 (botão `ok` "Ver atividades") guarda o corpo até o
 * toque. Ver `entregaPorAceite`.
 */
export const KINDS_ATIVIDADE: readonly string[] = ["activity_assigned", "activity_due", "activity_due_soon"];

/**
 * Nomes dos templates de atividade cujo botão é `ok` (v2 em diante): o que o
 * aceite aceita liberar no toque. Derivado das definições, não digitado.
 */
export function templatesDeAtividadeComAceite(): string[] {
  return KINDS_ATIVIDADE.flatMap((k) => templatesDoKind(k))
    .filter((d) => d.botao?.tipo === "ok")
    .map((d) => d.name)
    .filter((n, i, a) => a.indexOf(n) === i);
}

/**
 * O corpo desta linha só é entregue depois do OK/toque? Os kinds de
 * `KINDS_COM_ACEITE` sim, sempre que saíram por template; os de atividade só
 * se o template usado tem botão `ok` (v2). Fora da janela e sem template
 * (`templateName` nulo — texto livre), a pessoa já recebeu o corpo.
 */
export function entregaPorAceite(kind: string | null | undefined, templateName: string | null | undefined): boolean {
  if (!kind || !templateName) return false;
  if (KINDS_COM_ACEITE.includes(kind)) return true;
  return KINDS_ATIVIDADE.includes(kind) && templatesDeAtividadeComAceite().includes(templateName);
}

/**
 * O texto do aviso `credit_result` (M3): "A análise de crédito de {lead}
 * saiu: {decisao}. {link}". Dentro da janela é o texto livre; fora, é o que o
 * OK entrega. Só nome/código e rótulo — o emissor nunca manda CPF, renda ou
 * score (`upestate-runner.ts`). `null` sem os params: fica o corpo do emissor.
 */
export function textoDoAvisoDeCredito(params: Record<string, string> | null | undefined, link?: string | null): string | null {
  const decisao = params?.decisao?.trim();
  const lead = params?.lead?.trim();
  const proposta = params?.proposta?.trim();
  if (!decisao || (!lead && !proposta)) return null;
  const alvo = lead ? `de ${lead}` : `da proposta ${proposta}`;
  return `A análise de crédito ${alvo} saiu: ${decisao.replace(/[.\s]+$/, "")}.${link ? ` ${link}` : ""}`;
}

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
V2.credit_result = MENSAGEM_V2;

/**
 * Atividades pendentes v2 (25/10/2026, pedido do Olavo): o botão "Ver
 * atividades" deixa de abrir o app e vira resposta rápida `ok` — o toque
 * entrega no chat a lista de atividades (uma linha por atividade, com o link
 * do negócio), guardada no corpo da linha pelo contractmaker. Mesmo texto e
 * variáveis do v1 (a Meta já o aceitou; o v1 NÃO muda — o botão diferente
 * marcaria o v1 como DIVERGENTE no refresh). Enquanto o v2 não é APROVADO, o
 * envio segue pelo v1. Também "um por janela".
 */
const ATIVIDADES_PENDENTES_V2: TemplateDef = {
  ...t(
    "max_atividades_pendentes_v2",
    ATIVIDADES_PENDENTES.body,
    ATIVIDADES_PENDENTES.vars,
    ATIVIDADES_PENDENTES.exemplos,
    VER_ATIVIDADES_OK
  ),
  umPorJanela: true,
};
V2.activity_assigned = ATIVIDADES_PENDENTES_V2;
V2.activity_due = ATIVIDADES_PENDENTES_V2;
V2.activity_due_soon = ATIVIDADES_PENDENTES_V2;

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
V3.credit_result = MENSAGEM_V3;
V2.deal_form_reminder = V2.form_reminder;
V3.deal_form_reminder = V3.form_reminder;

/**
 * `proposal_completed` v2 (decisão do Olavo, 06/10/2026): a Meta aprovou o v1
 * como MARKETING — o convite "escolha se quer converter agora" + "Agora não"
 * leu como promoção. O v2 escreve como o `max_proposta_recusada` (UTILITY):
 * fato + o que dá para fazer pelo botão, com "Abrir proposta" no lugar do
 * "Agora não". Mesmas variáveis e params obrigatórios do v1.
 */
V2.proposal_completed = t(
  "max_proposta_assinada_v2",
  "Olá, {{1}}! A proposta {{2}}, da {{3}}, foi assinada por todos os signatários. Você pode converter a proposta em negócio pelo botão abaixo.",
  [NOME, PROPOSTA, ORG],
  ["Carlos", "PROP-0042 Apto Rua das Flores", "RE/MAX Trio"],
  { tipo: "acao_e_url", acao: CONVERTER, urlTexto: "Abrir proposta" },
  ["proposta"]
);

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

/**
 * Versão 5 — a família do AVISO (M9, 28/10/2026): o que sai fora da janela de
 * 24h casa com o que sai dentro dela. Cinco templates de resposta rápida cujo
 * toque volta como `av:<id da linha>:<ação>` e cai no MESMO roteador dos
 * botões da janela aberta (`lib/aviso-botao.ts`, M6). O emoji fixo do evento
 * abre o corpo; o botão não leva emoji e fica em até 20 caracteres.
 *
 * ── Quando um V5 pode sair (`templateUsavel`) ─────────────────────────────
 *  · só a linha com `aviso` v1 (emissor antigo cai no V4/V3/V2/v1);
 *  · TODA ação dos botões precisa estar em `aviso.acoes` — é o que o roteador
 *    confere no toque (`acao_fora_do_aviso`), e `aviso.acoes` já vem filtrada
 *    pela política pelo emissor, como os botões da janela aberta. O template
 *    tem botões FIXOS (a Meta recusa mandar menos, 132000): faltou uma ação,
 *    o V5 sai da disputa e o aviso vai pelo template anterior;
 *  · `max_marco_v5` exige `aviso.imagemUrl` https (cabeçalho de imagem).
 * Nenhum V5 oferece `concluir` nem `adiar_1d` (dependem de `activity.write`,
 * OFF) e nenhum kind de PARTE tem V5: a parte não conversa com o Max.
 *
 * Enquanto a Meta não aprova cada nome (`wa_template`), o envio segue pela
 * versão anterior — nada fica mudo (`outbox.ts`).
 */
const V5: Record<string, TemplateDef> = {};

const v5 = (
  name: string,
  body: string,
  vars: FonteDeVariavel[],
  exemplos: string[],
  respostas: RespostaAviso[],
  extra: Pick<TemplateDef, "cabecalho" | "umPorJanela"> = {}
): TemplateDef => {
  if (respostas.length < 1 || respostas.length > 3) throw new Error(`${name}: 1 a 3 respostas`);
  return { ...t(name, body, vars, exemplos, { tipo: "respostas", respostas }), ...extra };
};

/** Nível A — andamento do negócio (`stage_change` e o gêmeo do sino). */
const ANDAMENTO_V5 = v5(
  "max_negocio_andamento_v5",
  "📌 Olá, {{1}}! Andamento na {{2}}: *{{3}}*. Negócio: *{{4}}*. Os detalhes estão no botão abaixo.",
  [NOME, ORG, "titulo", NEGOCIO],
  ["Ana", "RE/MAX Trio", "Status do negócio atualizado", "Venda Apto 302"],
  [{ texto: "Abrir negócio", acao: "abrir" }]
);
V5.stage_change = ANDAMENTO_V5;
V5.deal_stage_change = ANDAMENTO_V5;

/** Nível B — formulário com respostas pendentes (`form_reminder` e o gêmeo do sino). */
const FORMULARIO_V5 = v5(
  "max_formulario_pendente_v5",
  "⏳ Olá, {{1}}! Status do negócio *{{2}}* na {{3}}: formulário com respostas pendentes das partes. Os botões abaixo reenviam o link ou abrem o formulário.",
  [NOME, NEGOCIO, ORG],
  ["Ana", "Venda Apto 302", "RE/MAX Trio"],
  [
    { texto: "Reenviar link", acao: "reenviar_link" },
    { texto: "Me lembra amanhã", acao: "lembrar_amanha" },
    { texto: "Ver formulário", acao: "ver_formulario" },
  ]
);
V5.form_reminder = FORMULARIO_V5;
V5.deal_form_reminder = FORMULARIO_V5;

/** Nível B — status de proposta (título do sistema, nunca o nome da parte). */
const PROPOSTA_V5 = v5(
  "max_proposta_v5",
  "📝 Olá, {{1}}! Status de proposta na {{2}}: *{{3}}*. Veja os detalhes nos botões abaixo.",
  [NOME, ORG, "titulo"],
  ["Ana", "RE/MAX Trio", "Proposta enviada para assinatura"],
  [
    { texto: "Ver proposta", acao: "ver_proposta" },
    { texto: "Abrir negócio", acao: "abrir" },
  ]
);
V5.proposal_created_status = PROPOSTA_V5;
V5.proposal_sent = PROPOSTA_V5;
V5.proposal_delivered = PROPOSTA_V5;

/**
 * Nível B — atividades pendentes, o mesmo aviso NEUTRO do v1/v2 (sem dado da
 * atividade) e o mesmo "um por janela". "Ver atividades" é a ação `abrir`: o
 * toque devolve o link do aviso (a lista fica no negócio). Um botão só: o
 * contractmaker manda, na atividade, `abrir` e (só com `activity.write`, hoje OFF)
 * `concluir`/`adiar_1d`. Não manda `lembrar_amanha`, e um botão que a linha não
 * traz deixaria o template inutilizável para sempre.
 */
const ATIVIDADES_V5 = v5(
  "max_atividades_v5",
  "📋 Olá, {{1}}! Você tem *atividades pendentes* na {{2}}. Toque no botão abaixo para ver as atividades.",
  [NOME, ORG],
  ["Ana", "RE/MAX Trio"],
  [
    { texto: "Ver atividades", acao: "abrir" },
  ],
  { umPorJanela: true }
);
V5.activity_assigned = ATIVIDADES_V5;
V5.activity_due = ATIVIDADES_V5;
V5.activity_due_soon = ATIVIDADES_V5;

/**
 * Nível C — marco, com cabeçalho de IMAGEM (`aviso.imagemUrl`). UM template
 * neutro para os três marcos: o emoji fixo é 🎉 e o que diferencia o fato é o
 * título (variável) e a imagem. Um por marco (✅/🎉/🏠) seriam três análises da
 * Meta e três imagens de exemplo para um ganho de enfeite. `proposal_completed`
 * NÃO tem V5: não é de um negócio (um "Abrir negócio" mentiria) e o v2 oferece o
 * "Converter" em negócio pelo `acao:`, que o V5 perderia. `captacao_signed_status`
 * também não: não está no `CATALOGO` (fora da régua, só texto livre na janela).
 */
const MARCO_V5 = v5(
  "max_marco_v5",
  "🎉 Olá, {{1}}! Marco na {{2}}: *{{3}}*. Os detalhes estão nos botões abaixo.",
  [NOME, ORG, "titulo"],
  ["Ana", "RE/MAX Trio", "Contrato assinado"],
  [
    { texto: "Abrir negócio", acao: "abrir" },
    { texto: "Próximo passo", acao: "criar_atividade" },
  ],
  { cabecalho: { tipo: "imagem" } }
);
V5.contract_signed = MARCO_V5;
V5.contract_signed_status = MARCO_V5;

/** Todos os templates (sem repetição, todas as versões), para a submissão, o refresh e os testes de regra. */
export function todosOsTemplates(): TemplateDef[] {
  return [
    ...new Map(
      [
        ...Object.values(CATALOGO),
        ...Object.values(V2),
        ...Object.values(V3),
        ...Object.values(V4),
        ...Object.values(V5),
      ].map((d) => [d.name, d])
    ).values(),
  ];
}

/**
 * Os templates do `kind` em ordem de preferência — a versão mais nova primeiro
 * ([v5, v4, v3, v2, v1], pulando as versões que esse `kind` não tem) —, ou `[]`
 * quando o tipo está FORA DA RÉGUA. O envio usa o aprovado, de preferência
 * não MARKETING (`outbox.ts`).
 */
export function templatesDoKind(kind: string | null | undefined): TemplateDef[] {
  if (!kind || !CATALOGO[kind]) return [];
  return [V5[kind], V4[kind], V3[kind], V2[kind], CATALOGO[kind]].filter((d): d is TemplateDef => !!d);
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
  /**
   * Contrato `aviso` v1 da linha (M9). Os templates V5 só são usáveis com ele
   * (ver `templateUsavel`); os demais ignoram estes quatro campos.
   */
  aviso?: Aviso | null;
  audience?: string;
  link_url?: string | null;
  deal_id?: string | null;
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
  if (def.paramsObrigatorios && def.paramsObrigatorios.length > 0) {
    if (!def.paramsObrigatorios.every((chave) => !!linha.params?.[chave]?.trim())) return false;
  }
  return avisoPermiteTemplate(def, linha);
}

/** Ações que o roteador do M6 responde com o link do aviso (`aviso-botao.ts`: `COM_LINK` e `criar_atividade`). */
const ACOES_QUE_PRECISAM_DE_LINK: ReadonlySet<AcaoAviso> = new Set(["abrir", "ver_formulario", "ver_proposta", "criar_atividade"]);
/** Ações que o roteador só aceita com `alvoId` no aviso (e, no reenvio, com o negócio da linha). */
const ACOES_QUE_PRECISAM_DE_ALVO: ReadonlySet<AcaoAviso> = new Set(["reenviar_link", "concluir", "adiar_1d"]);

/**
 * O que o template V5 pede da linha (M9). Templates sem `respostas` nem
 * `cabecalho` não pedem nada. Cada exigência espelha uma recusa do roteador
 * do toque (`rotearBotaoDeAviso`), para o template nunca oferecer um botão que
 * ele vá recusar:
 *  · sem `aviso` v1, ou aviso de PARTE (`deal_party`), não há V5;
 *  · toda ação do botão está em `aviso.acoes` (senão `acao_fora_do_aviso`);
 *  · ação de link precisa de `aviso.link.url` ou do `link_url` da linha;
 *  · `reenviar_link` precisa do `alvoId` da ação e do `deal_id` da linha;
 *  · cabeçalho de imagem precisa de `aviso.imagemUrl` https.
 * A POLÍTICA do destinatário (`form.create` etc.) só se conhece no toque; o
 * emissor já filtra `aviso.acoes` por ela, e o roteador confere de novo.
 */
function avisoPermiteTemplate(def: TemplateDef, linha: LinhaParaTemplate): boolean {
  const respostas = def.botao?.tipo === "respostas" ? def.botao.respostas : null;
  if (!respostas && !def.cabecalho) return true;
  const aviso = linha.aviso;
  if (!aviso || aviso.v !== 1) return false;
  if (linha.audience === "deal_party") return false;
  if (def.cabecalho?.tipo === "imagem" && !(aviso.imagemUrl ?? "").startsWith("https://")) return false;
  for (const r of respostas ?? []) {
    const item = aviso.acoes.find((a) => a.id === r.acao);
    if (!item) return false;
    if (ACOES_QUE_PRECISAM_DE_LINK.has(r.acao) && !(aviso.link?.url || linha.link_url)) return false;
    if (ACOES_QUE_PRECISAM_DE_ALVO.has(r.acao) && !item.alvoId) return false;
    if (r.acao === "reenviar_link" && !linha.deal_id) return false;
  }
  return true;
}

/** O primeiro parâmetro obrigatório que falta nesta linha, ou `null`. */
export function parametroObrigatorioFaltando(def: TemplateDef, linha: LinhaParaTemplate): string | null {
  return def.paramsObrigatorios?.find((chave) => !linha.params?.[chave]?.trim()) ?? null;
}

/**
 * Template que o `templates-sync` NÃO submete (M9): cabeçalho de imagem exige
 * `example.header_handle` (upload), então vai pelo Gerenciador do WhatsApp —
 * `docs/templates-v5-para-submeter.md`.
 */
export function submeteSoPeloGerenciador(def: TemplateDef): boolean {
  return !!def.cabecalho;
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
