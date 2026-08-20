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

/**
 * O que o Max sabe criar. `venda` e `locacao` são formulário em branco + link;
 * `proposta` é um RASCUNHO de proposta + link.
 */
export const TIPOS_CRIAVEIS = ["venda", "locacao", "proposta"] as const;
export type TipoCriavel = (typeof TIPOS_CRIAVEIS)[number];

export interface PendingAction {
  kind: "criar_documento";
  args: {
    tipo: TipoCriavel;
    nomeCliente?: string;
    /** Só proposta: de compra e venda (default) ou de locação. */
    natureza?: "venda" | "locacao";
    /** Só locação e proposta de locação. */
    finalidade?: "residencial" | "comercial";
  };
  /** Epoch ms de quando a proposta foi feita. */
  askedAt: number;
  /** `messageId` do turn que propôs — rastro. */
  askedForMessageId: string;
}

export const TOOL_PROPOR_FORM = "propor_criacao";

/**
 * UMA ferramenta com um parâmetro, e não três ferramentas parecidas.
 *
 * Modelo pequeno erra mais escolhendo entre ferramentas de descrição vizinha
 * ("criar formulário de venda" × "criar formulário de locação") do que
 * preenchendo um enum — as três se desambiguam entre si e a fronteira fica na
 * redação, que é onde ele é fraco. Com um enum, a decisão vira uma palavra que
 * a própria pessoa disse.
 *
 * Bônus: a definição que vai no prompt fica ~1/3 do tamanho, em todo turn que
 * passa o prefiltro.
 */
export const FORM_TOOL: LlmTool = {
  name: TOOL_PROPOR_FORM,
  /**
   * A descrição é o que decide a chamada — mais que o prompt.
   *
   * A primeira versão embutia "se não deixou claro se é venda ou aluguel, NÃO
   * chame: pergunte" dentro do parâmetro `tipo`. Medido: o recall caiu de 100%
   * para 50%, e os TRÊS casos de proposta falharam — o modelo lia aquilo como
   * condição de bloqueio geral e se abstinha, inclusive onde "venda ou aluguel"
   * nem se aplicava. Desambiguar é assunto do prompt; aqui só se descreve o que
   * a ferramenta faz.
   */
  description:
    "Cria um formulário ou uma proposta e devolve o link. Chame sempre que a " +
    "pessoa pedir para CRIAR, ABRIR, GERAR ou MANDAR um formulário, uma ficha, " +
    "um cadastro, uma proposta ou o link de preenchimento — mesmo que ela não " +
    "dê detalhes. A criação não acontece agora: a pessoa ainda confirma depois.",
  parameters: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: [...TIPOS_CRIAVEIS],
        description:
          "venda = formulário de compra e venda (comprador, imóvel à venda). " +
          "locacao = formulário de aluguel (inquilino, locação, locatário). " +
          "proposta = rascunho de proposta comercial, de venda OU de aluguel — " +
          "pedido com a palavra 'proposta' é deste tipo; aluguel vai em natureza.",
      },
      nome_cliente: {
        type: "string",
        description:
          "Nome do cliente, se a pessoa disse. Omita se ela não disse — " +
          "não invente nem deduza.",
      },
      natureza: {
        type: "string",
        enum: ["venda", "locacao"],
        description:
          "Só para proposta: venda = proposta de compra e venda; locacao = " +
          "proposta de aluguel/locação. Omita se a pessoa não disse — o " +
          "padrão é venda.",
      },
      finalidade: {
        type: "string",
        enum: ["residencial", "comercial"],
        description:
          "Só para locação (formulário ou proposta). Omita se a pessoa não " +
          "disse — o padrão é residencial.",
      },
    },
    required: ["tipo"],
    additionalProperties: false,
  },
};

/** Lê o `tipo` da chamada do modelo. `null` quando ele mandou algo fora do enum. */
export function lerTipo(bruto: unknown): TipoCriavel | null {
  return typeof bruto === "string" &&
    (TIPOS_CRIAVEIS as readonly string[]).includes(bruto)
    ? (bruto as TipoCriavel)
    : null;
}

export function lerFinalidade(
  bruto: unknown
): "residencial" | "comercial" | undefined {
  return bruto === "comercial" || bruto === "residencial" ? bruto : undefined;
}

/** Fora do enum → undefined (= venda): valor estranho não pode virar locação. */
export function lerNatureza(bruto: unknown): "venda" | "locacao" | undefined {
  return bruto === "venda" || bruto === "locacao" ? bruto : undefined;
}

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
  /(formul[aá]ri|ficha|cadastr|link|proposta|abrir?|cri(a|ar|e)|nov[oa] (neg[oó]cio|venda|loca[cç][aã]o|cliente)|manda?r? o link)/i;

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
/** Como cada tipo é chamado na conversa. Uma fonte só, usada nos três textos. */
const NOME_DO_TIPO: Record<TipoCriavel, string> = {
  venda: "formulário de venda",
  locacao: "formulário de locação",
  proposta: "rascunho de proposta",
};

export function descreverPendencia(args: PendingAction["args"]): string {
  // A descrição é o que a pessoa CONFIRMA — proposta de locação não pode
  // aparecer como "rascunho de proposta" genérico, senão ela confirma achando
  // que é de venda.
  const ehPropostaLocacao = args.tipo === "proposta" && args.natureza === "locacao";
  const base = ehPropostaLocacao
    ? "rascunho de proposta de locação"
    : NOME_DO_TIPO[args.tipo];
  const temFinalidade = args.tipo === "locacao" || ehPropostaLocacao;
  const fim = temFinalidade && args.finalidade === "comercial" ? " comercial" : "";
  return `${base}${fim}`;
}

export function textoProposta(args: PendingAction["args"]): string {
  const alvo = args.nomeCliente ? ` para ${args.nomeCliente}` : "";
  const oQue = descreverPendencia(args);
  const paraQue =
    args.tipo === "proposta"
      ? "e te mandar o link para completar os valores"
      : "e te mandar o link para o cliente preencher";
  return (
    `Posso criar um ${oQue}${alvo} ${paraQue}.\n\n` +
    `Confirma? Responde SIM que eu crio.`
  );
}

export function textoCriado(params: {
  url: string;
  args: PendingAction["args"];
}): string {
  const alvo = params.args.nomeCliente ? ` de ${params.args.nomeCliente}` : "";
  const oQue = descreverPendencia(params.args);

  // A proposta nasce RASCUNHO e sem valores — dizer isso é o que impede o
  // corretor de mandar o link direto pro cliente achando que está pronto.
  if (params.args.tipo === "proposta") {
    return (
      `Pronto, ${oQue}${alvo} criado — ainda em RASCUNHO, sem valores. ` +
      `Completa por aqui antes de mandar pro cliente:\n\n${params.url}`
    );
  }

  return (
    `Pronto, ${oQue}${alvo} criado. Manda este link para o cliente ` +
    `preencher:\n\n${params.url}`
  );
}

/**
 * O tenant não tem o módulo/feature ligado.
 *
 * Mensagem própria porque a causa é diferente de falha: nada vai dar certo
 * tentando de novo, e quem resolve não é o corretor — é a imobiliária ligando o
 * módulo. Devolver "tenta de novo em instantes" mandaria a pessoa bater na
 * mesma parede.
 */
export function textoModuloDesligado(args: PendingAction["args"]): string {
  return (
    `Não consegui criar: ${descreverPendencia(args)} não está habilitado nesta ` +
    `imobiliária. Nada foi criado. Fala com quem administra a conta.`
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

// A recusa a corretor sem login NÃO mora aqui: ela é uma instrução condicional
// do prompt (`NAO_SABE_CRIAR_FORM` em prompt.ts), porque a pessoa pode estar
// perguntando outra coisa junto e uma frase pronta atropelaria a pergunta dela.
// O determinismo que importa — o texto que a pessoa CONFIRMA e o link que ela
// recebe — segue por template acima.
