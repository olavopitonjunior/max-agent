/**
 * GOLDEN SET do Max e do Newton: conversas curtas, dados 100% sintéticos, com a
 * expectativa escrita ANTES de existir a correção. O baseline falha em vários
 * casos de propósito: cada falha aponta um defeito de produto conhecido (origem).
 *
 * Como rodar (modelo real via OpenRouter, ImobPro simulado, nada é gravado):
 *
 *   # Max (perfil vazio)
 *   OPENROUTER_API_KEY=... EVAL_N=1 EVAL_REPORT_ONLY=true \
 *     EVAL_SAIDA=/caminho/golden-max.json \
 *     npx vitest run --config vitest.eval.config.ts scripts/eval-golden.eval.ts
 *
 *   # Newton
 *   OPENROUTER_API_KEY=... AGENT_DEPLOY_PROFILE=newton EVAL_N=1 EVAL_REPORT_ONLY=true \
 *     EVAL_SAIDA=/caminho/golden-newton.json \
 *     npx vitest run --config vitest.eval.config.ts scripts/eval-golden.eval.ts
 *
 * Variáveis: EVAL_N (repetições, 1–10), EVAL_SO (regex em id/origem; roda só
 * esses casos), EVAL_SAIDA (JSON com métricas e uma linha por turno),
 * EVAL_REPORT_ONLY=true (relata sem reprovar; sem isso o gate vale).
 * Sem juiz LLM: toda checagem é determinística (texto, verbos, argumentos).
 *
 * Gate (docs/superpowers/evaluation-gates.md): 0 promessa sem efeito, 0 violação
 * de formato, >= 98% de ações certas, e proposta concluída em <= 3 perguntas.
 *
 * Dados: nomes "TESTE ...", telefone 11999990000. O único CPF é o válido de teste
 * 111.444.777-35 (casos marcados `sintetico`). Nada aqui é pessoa real.
 */

export type BotGolden = "max" | "newton";
export type AmbienteGolden = "consultas" | "captacao" | "credito";

/** Conferência de argumento: caminho pontuado (ex.: "dados.imovel.uf") -> valor esperado. */
export interface ConfereArgs {
  verbo: string;
  /** string = igualdade; RegExp = teste sobre String(valor); true = só precisa existir. */
  contem: Record<string, string | RegExp | true>;
}

export interface Esperado {
  /** Verbos que TÊM de ser chamados no turno. */
  acoes?: string[];
  /** Verbos que NÃO podem ser chamados no turno. */
  acoesProibidas?: string[];
  contem?: (string | RegExp)[];
  naoContem?: (string | RegExp)[];
  args?: ConfereArgs[];
}

export interface TurnoGolden {
  usuario: string;
  esperado: Esperado;
}

export interface CasoGolden {
  id: string;
  /** De onde veio o caso (achado de teste manual, semana, rodada). */
  origem: string;
  bot: BotGolden;
  /** Flags do ambiente simulado. Padrão: consultas + captação. */
  ambiente?: AmbienteGolden[];
  /** Simula o credit.request (só o caso de crédito). */
  envio?: "aprovado" | "sem_resposta";
  /** O caso usa CPF de teste (111.444.777-35). */
  sintetico?: boolean;
  /** Tipo de tarefa para `perguntasPorTarefa` (conta turnos até o card de confirmação). */
  tarefa?: "proposta" | "captacao";
  /** Nomes de terceiros que nunca podem virar vocativo ("Pronto, João!"). */
  terceiros?: string[];
  turnos: TurnoGolden[];
}

/**
 * Terceiros padrão do cenário simulado: clientes, nunca o usuário (Olavo).
 * "Comprador" sozinho fica de fora: é rótulo do resumo ("Comprador: ..."), não vocativo.
 */
export const TERCEIROS_PADRAO = ["Letícia", "Carlos", "Renato", "João", "Pedro", "Maria", "TESTE Comprador"];

/** Regras de formato valem em TODO turno de TODO caso (ver violacoesDeFormato). */
export const FORMATO_GLOBAL = ["**", "##", "⟨", "n=<dígitos>", "vocativo de terceiro"] as const;

const CPF_TESTE = "111.444.777-35";
const PROPOSTA_PARTES_PEDIDO =
  "Quero fazer uma proposta de compra: comprador TESTE Comprador, casado, tel 11999990000, " +
  "imóvel Apto TESTE Rua Teste 30, São Paulo/SP, R$ 500.000 à vista";

/** Ficha de crédito até o resumo final (autorização, CPF, vínculo, renda, custos, composição). */
const FICHA_ATE_REVISAO: TurnoGolden[] = [
  { usuario: "faz a ficha de crédito da Letícia Andrade", esperado: { contem: [/Responda \*?SIM\*?/], acoesProibidas: ["credit.request"] } },
  { usuario: "sim", esperado: { contem: [/CPF/], acoesProibidas: ["credit.request"] } },
  { usuario: CPF_TESTE, esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "CLT", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "analista", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "8 mil", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "2500", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "não tem", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "não tem", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "sozinha", esperado: { acoesProibidas: ["credit.request"] } },
  { usuario: "não", esperado: { contem: ["Responda *SIM*"], acoesProibidas: ["credit.request"] } },
];

export const CASOS: CasoGolden[] = [
  // ─── Proposta de compra em partes (M4') ────────────────────────────────────
  {
    id: "m4-proposta-compra-em-partes",
    origem: "M4' — proposta de compra pedida em partes: não oferecer 'rápida ou formulário', não descartar 'casado', CPF pedido no 'ainda falta'",
    bot: "max",
    tarefa: "proposta",
    sintetico: true,
    turnos: [
      {
        usuario: PROPOSTA_PARTES_PEDIDO,
        esperado: {
          naoContem: [/r[aá]pida ou (o )?formul[aá]rio/i, /proposta r[aá]pida/i],
          contem: [/casad/i, /ainda falta[\s\S]*CPF/i],
          acoesProibidas: ["proposal.create", "proposal.send"],
        },
      },
      { usuario: `o CPF dele é ${CPF_TESTE}`, esperado: { contem: [/\bSIM\b/], acoesProibidas: ["proposal.create", "proposal.send"] } },
      { usuario: "sim", esperado: { acoes: ["proposal.create"], acoesProibidas: ["proposal.send"] } },
    ],
  },

  // ─── Envio por código de proposta (M6b) ────────────────────────────────────
  {
    id: "m6b-enviar-proposta-por-codigo",
    origem: "M6b — 'manda a PROP-2026-0003 pro comprador assinar': sem vocativo de cliente, sem perguntar 'celular ou link no WhatsApp'",
    bot: "max",
    turnos: [
      {
        usuario: "manda a PROP-2026-0003 pro comprador assinar",
        esperado: {
          naoContem: [/celular ou (o )?link/i],
          contem: ["0003"],
          acoesProibidas: ["proposal.send"],
        },
      },
    ],
  },

  // ─── Formulário do comprador do TESTE1 (M8/R5) ─────────────────────────────
  {
    id: "m8-r5-formulario-comprador-do-teste1",
    origem: "M8/R5 — 'formulário para o comprador do TESTE1': não abre criação de negócio novo",
    bot: "max",
    turnos: [
      {
        usuario: "formulário para o comprador do TESTE1",
        esperado: {
          naoContem: [/Que nome dou/i, /gerente/i],
          acoesProibidas: ["form.create"],
        },
      },
    ],
  },

  // ─── Negócios parados (M9) ──────────────────────────────────────────────────
  {
    id: "m9-negocios-parados",
    origem: "M9 — 'negócios parados há mais tempo': a lista cortada não pode virar a palavra 'truncada'",
    bot: "max",
    turnos: [
      {
        usuario: "quais os negócios parados há mais tempo?",
        esperado: { naoContem: [/truncad/i], acoes: ["deal.list"] },
      },
    ],
  },

  // ─── Pendências / status por nome (acesso falso negado) ─────────────────────
  {
    id: "pendencias-negocio-teste-assinatura-4",
    origem: "W46 — pendências do negócio 'TESTE assinatura 4' respondia 'sem_permissao' e 'n=' ao corretor",
    bot: "max",
    turnos: [
      {
        usuario: "quais as pendências do negócio TESTE assinatura 4?",
        esperado: { naoContem: [/sem_permissao/, /\bn=/] },
      },
    ],
  },
  {
    id: "status-contrato-teste-assinatura-2",
    origem: "W46 — status do contrato 'TESTE assinatura 2' respondia 'sem_permissao' e 'n=' ao corretor",
    bot: "max",
    turnos: [
      {
        usuario: "qual o status do contrato do TESTE assinatura 2?",
        esperado: {
          naoContem: [/sem_permissao/, /\bn=/],
          acoes: ["contract.status"],
          args: [{ verbo: "contract.status", contem: { negocio_id: "dn-assinatura-2" } }],
        },
      },
    ],
  },
  {
    id: "newton-status-contrato-teste1",
    origem: "W46 — Newton lia 'TESTE1' como item 1 da lista e dizia 'tente de novo mais tarde'",
    bot: "newton",
    turnos: [
      {
        usuario: "qual o status do contrato do TESTE1?",
        esperado: {
          naoContem: [/tente (de novo|novamente) mais tarde/i, /(item|n[úu]mero|n[º°]?)\s*1\b/i],
          acoes: ["contract.status"],
          args: [{ verbo: "contract.status", contem: { negocio_id: "dn-teste1" } }],
        },
      },
    ],
  },

  // ─── Captação em mensagem única (R2) ────────────────────────────────────────
  ...(["max", "newton"] as const).map((bot): CasoGolden => ({
    id: `r2-captacao-mensagem-unica-${bot}`,
    origem: "R2 — captação com tudo na primeira mensagem: não pergunta 'Que nome dou', não pede o valor de novo; create com proprietário e cidade/UF",
    bot,
    ambiente: ["consultas", "captacao"],
    tarefa: "captacao",
    turnos: [
      {
        usuario:
          "nova captação TESTE: proprietário Pedro TESTE Captação, tel 11999990000, " +
          "imóvel Rua TESTE Captação, 5, São Paulo/SP, venda R$ 800.000",
        esperado: {
          naoContem: [/Que nome dou/i, /qual (é )?o valor/i],
          acoesProibidas: ["captacao.send"],
        },
      },
      {
        usuario: "sim",
        esperado: {
          contem: [/800\.000/],
          naoContem: [/Que nome dou/i, /qual (é )?o valor/i, /valor pretendido/i],
          acoes: ["captacao.create"],
          acoesProibidas: ["captacao.send"],
          args: [
            {
              verbo: "captacao.create",
              contem: { "dados.proprietarios.0.nome": /Pedro/, "dados.imovel.cidade": "São Paulo", "dados.imovel.uf": "SP" },
            },
          ],
        },
      },
    ],
  })),

  // ─── Tipos de assinatura (R3) ───────────────────────────────────────────────
  {
    id: "r3-newton-tipos-de-assinatura",
    origem: "R3 — Newton respondia 'foge do que eu faço' para 'quais os tipos de assinatura?'",
    bot: "newton",
    turnos: [
      {
        usuario: "quais os tipos de assinatura?",
        esperado: { naoContem: [/foge do que eu fa[çc]o/i], contem: [/Aceite/] },
      },
    ],
  },

  // ─── Propostas da imobiliária no mês (R4) ───────────────────────────────────
  ...(["max", "newton"] as const).map((bot): CasoGolden => ({
    id: `r4-propostas-da-imobiliaria-mes-${bot}`,
    origem: "R4 — owner pergunta pela imobiliária e o bot respondia só com as propostas dele",
    bot,
    turnos: [
      {
        usuario: "quantas propostas a imobiliária fez este mês?",
        esperado: { contem: [/\b12\b/], naoContem: [/que voc[êe] criou/i, /suas propostas/i] },
      },
    ],
  })),

  // ─── Complemento na revisão (W46) ───────────────────────────────────────────
  {
    id: "w46-complemento-na-revisao",
    origem: "W46 — 'o complemento é apartamento 1' na revisão: respondia 'ajusto' sem mostrar o resumo atualizado",
    bot: "max",
    tarefa: "proposta",
    turnos: [
      { usuario: "Quero criar uma proposta de venda", esperado: { acoesProibidas: ["proposal.create", "proposal.send"] } },
      { usuario: "1", esperado: { acoesProibidas: ["proposal.create", "proposal.send"] } },
      {
        usuario: "Comprador: TESTE Comprador; telefone 11999990000; imóvel Rua de Teste QA, 100, São Paulo/SP; valor R$ 500.000,00 à vista.",
        esperado: { acoesProibidas: ["proposal.create", "proposal.send"] },
      },
      {
        usuario: "o complemento é apartamento 1",
        esperado: {
          naoContem: [/\bajusto\b/i, /vou ajustar/i],
          contem: [/apartamento 1/i, /SIM/],
          acoesProibidas: ["proposal.create", "proposal.send"],
        },
      },
    ],
  },

  // ─── Crédito: "ok" não envia (W46) ──────────────────────────────────────────
  {
    id: "w46-credito-ok-nao-executa",
    origem: "W46 — 'ok' no card de crédito disparava o envio pago; só o SIM explícito vale",
    bot: "max",
    ambiente: ["consultas", "credito"],
    envio: "aprovado",
    sintetico: true,
    turnos: [
      ...FICHA_ATE_REVISAO,
      { usuario: "ok", esperado: { acoesProibidas: ["credit.request"] } },
    ],
  },
];
