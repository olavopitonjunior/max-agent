import type { LlmTool } from "@/lib/llm";
import type { Candidate } from "@/lib/identity";

/**
 * Ferramentas do Max — e, mais importante, o que elas NÃO são.
 *
 * **Nenhuma ferramenta executa.** `propor_formulario_venda` só registra uma
 * proposta no estado do grafo; quem executa é o nó `confirm`, no turno seguinte,
 * depois que a pessoa confirmou. A diferença não é estilística:
 *
 * - A base de conhecimento que entra no prompt vem de material que a imobiliária
 *   sobe, e parte tem origem em formulário público ANÔNIMO. Com ferramenta que
 *   executa, uma injeção ali viraria ação. Como o modelo só consegue PROPOR, o
 *   pior caso de uma injeção é o Max fazer uma pergunta boba — e um humano ainda
 *   precisa dizer sim.
 * - O texto que a pessoa lê para confirmar, e o link que ela recebe depois, saem
 *   de TEMPLATE, não do modelo. Uma URL não pode passar por um gerador de texto,
 *   e um `gpt-5.4-nano` parafraseando os dados da confirmação anularia o valor
 *   de confirmar.
 */

/** Quanto tempo uma proposta pendente continua válida. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

export interface PendingAction {
  kind: "criar_form_venda";
  args: { nomeCliente?: string };
  /** Epoch ms de quando a proposta foi feita. */
  askedAt: number;
  /** `messageId` do turn que propôs — rastro, e chave de idempotência na execução. */
  askedForMessageId: string;
}

export const TOOL_PROPOR_FORM = "propor_formulario_venda";

export const FORM_TOOL: LlmTool = {
  name: TOOL_PROPOR_FORM,
  description:
    "Propõe criar um formulário de venda em branco e devolver o link público " +
    "para o cliente preencher. Use quando a pessoa PEDIR um formulário, uma " +
    "ficha, um cadastro de cliente ou o link de preenchimento. Não use para " +
    "perguntas sobre como o formulário funciona.",
  parameters: {
    type: "object",
    properties: {
      nome_cliente: {
        type: "string",
        description:
          "Nome do cliente, se a pessoa disse. Omita se ela não disse — " +
          "não invente nem deduza.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * Só usuário da plataforma escreve.
 *
 * Um `BrokerCandidate` é corretor comissionado (`SplitRecipient`), não tem
 * `User` e portanto não tem `userId`. O formulário que ele pedisse nasceria sem
 * dono E sem comissionado — órfão dos dois lados, o que é pior que não criar.
 * A ferramenta nem é oferecida ao modelo nesse caso: recusar antes é mais
 * barato e mais previsível que recusar depois.
 */
export function podeEscrever(identity: Candidate): identity is Extract<
  Candidate,
  { kind: "user" }
> {
  return identity.kind === "user";
}

/**
 * Vale expor a ferramenta neste turn?
 *
 * Heurística barata, na linha do `shouldSearch`: expor em toda mensagem custaria
 * os tokens da definição em TODO turn e daria ao nano mais oportunidade de
 * chamar sem motivo. O corte é generoso de propósito — falso positivo custa
 * alguns tokens de entrada, falso negativo custa a feature inteira.
 */
const PEDE_ESCRITA =
  /(formul[aá]ri|ficha|cadastr|link|abrir?|cri(a|ar|e)|nov[oa] (neg[oó]cio|venda|cliente)|manda?r? o link)/i;

export function shouldOfferTools(text: string): boolean {
  return PEDE_ESCRITA.test(text);
}

/**
 * Normaliza para comparação: minúsculas, sem acento, sem pontuação de sobra.
 *
 * Emoji sobrevive de propósito — "👍" é uma confirmação legítima no WhatsApp.
 */
function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Casamento ANCORADO na mensagem inteira, e não busca de trecho.
 *
 * É a diferença entre "sim" e "sim, mas espera" — o segundo não é confirmação, e
 * um `includes("sim")` executaria a escrita mesmo assim. Mesmo espírito do
 * `matchChoice`: acerto único e inequívoco, ou nada.
 *
 * A lista é curta porque a pergunta diz à pessoa exatamente o que responder. Não
 * é para adivinhar intenção — é para reconhecer a resposta que pedimos.
 */
const AFIRMA =
  /^(sim|s|isso( mesmo)?|isso ai|ok|okay|okey|blz|beleza|certo|claro|perfeito|positivo|confirmo?|confirmado|pode( ser| criar| mandar| fazer)?|manda( ai| ver)?|cri(a|ar)|faz(er)?( isso)?|vai|bora|aham|uhum|com certeza|ta|ta bom|ta certo|👍|✅|👌|🙏)$/;

const NEGA =
  /^(nao|n|nn|nops?|nope|negativo|deixa( pra la| quieto)?|cancela|esquece|para|nada|agora nao|melhor nao|nao precisa|nao quero|nao e isso|❌|👎)$/;

export type Confirmacao = "sim" | "nao" | "nenhum";

export function lerConfirmacao(texto: string): Confirmacao {
  const t = normalizar(texto);
  if (!t) return "nenhum";
  // Negativa primeiro: "nao pode" tem que cair aqui, não no ramo afirmativo.
  if (NEGA.test(t)) return "nao";
  if (AFIRMA.test(t)) return "sim";
  return "nenhum";
}

export function propostaExpirou(pending: PendingAction, agora: number): boolean {
  return agora - pending.askedAt > PENDING_TTL_MS;
}

// ─── Textos ────────────────────────────────────────────────────────────────
// Todos por template, nunca gerados. Ver o cabeçalho do arquivo.

/**
 * A pergunta diz a palavra exata que confirma.
 *
 * Sem isso, o casamento estrito viraria armadilha: a pessoa responderia "sim,
 * pode criar pro João" e o Max não reconheceria. Ou o matcher afrouxa e passa a
 * aceitar "sim, mas...", ou a pergunta ensina — e ensinar é o lado seguro.
 */
export function textoProposta(args: { nomeCliente?: string }): string {
  const alvo = args.nomeCliente ? ` para ${args.nomeCliente}` : "";
  return (
    `Posso criar um formulário de venda${alvo} e te mandar o link para o ` +
    `cliente preencher.\n\nConfirma? Responde SIM que eu crio.`
  );
}

export function textoCriado(params: {
  url: string;
  nomeCliente?: string;
}): string {
  const alvo = params.nomeCliente ? ` de ${params.nomeCliente}` : "";
  return (
    `Pronto, formulário${alvo} criado. Manda este link para o cliente ` +
    `preencher:\n\n${params.url}`
  );
}

export const TEXTO_CANCELADO = "Beleza, não criei nada.";

/**
 * A escrita falhou DEPOIS de a pessoa confirmar.
 *
 * Precisa dizer que não criou. Um "tive um problema" genérico deixaria dúvida
 * sobre o formulário ter nascido ou não, e a pessoa ou pediria de novo (criando
 * dois) ou esperaria um link que nunca vem.
 */
export const TEXTO_FALHOU =
  "Não consegui criar o formulário agora — nada foi criado. " +
  "Tenta de novo em instantes, ou cria pelo sistema se for urgente.";

/** Corretor sem login pediu escrita. Dizer de quem é o caminho, não sumir com o assunto. */
export const TEXTO_SEM_PERMISSAO =
  "Criar formulário ainda é pelo sistema, com quem tem login na imobiliária. " +
  "Fala com seu gerente que ele gera o link em um minuto.";
