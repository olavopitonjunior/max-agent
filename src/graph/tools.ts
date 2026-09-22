import type { LlmTool } from "@/lib/llm";
import type { Capability } from "./policy";
import type { ScopeQueryVerb } from "./scope-contract";
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
 * O catálogo, por NOME.
 *
 * Existe para o sanitizador da saída (`compose.ts`) saber o que nunca pode
 * aparecer na conversa. Manter aqui, e não lá, é o que faz a tool que o PR 6
 * acrescentar nascer bloqueada sem ninguém lembrar de editar dois arquivos.
 */
export const NOMES_DE_TOOL: string[] = [
  TOOL_PROPOR_FORM,
  "listar_negocios",
  "pendencias_do_negocio",
  "listar_propostas",
];

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
export function textoFalhou(args: Pick<PendingAction["args"], "tipo">): string {
  // O que falhou tem nome: dizer "formulário" quando foi uma proposta deixava
  // a pessoa achando que pediu a coisa errada.
  const oque = args.tipo === "proposta" ? "a proposta" : "o formulário";
  return (
    `Não consegui criar ${oque} agora — nada foi criado. ` +
    "Tenta de novo em instantes, ou cria pelo sistema se for urgente."
  );
}

// A recusa a corretor sem login NÃO mora aqui: ela é uma instrução condicional
// do prompt (`NAO_SABE_CRIAR_FORM` em prompt.ts), porque a pessoa pode estar
// perguntando outra coisa junto e uma frase pronta atropelaria a pergunta dela.
// O determinismo que importa — o texto que a pessoa CONFIRMA e o link que ela
// recebe — segue por template acima.

// ─────────────────────────────────────────────────────────────────────────────
// PR 6a — a máquina de tools de LEITURA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Definição única: uma tool, dois consumidores (o prompt e o executor).
 *
 * `capability` é o que a política governa; `verb` é o que o `scope-query`
 * executa. Separados de propósito — a política diz o que se pode OFERECER, o
 * servidor decide o que VOLTA. Confundir os dois produz vazamento que nenhum
 * teste deste repo pega (`docs/max.md` §11.4).
 */
export interface ToolDef {
  def: LlmTool;
  capability: Capability;
  verb: ScopeQueryVerb;
  /** Menor = entra primeiro quando o teto de 5 corta. */
  prioridade: number;
  /** Prefiltro barato por intenção. Generoso de propósito — ver abaixo. */
  combina: (texto: string) => boolean;
}

/**
 * Teto do catálogo de LEITURA por chamada. A `propor_criacao` é somada por
 * fora, em `graph.ts` (hoje 3 leituras + 1 escrita = 4); se o catálogo de
 * leitura chegar a 5, o total enviado passa do teto — rever antes.
 *
 * Acima disso a precisão do nano cai — é a mesma medição que fez `propor_criacao`
 * ser UMA tool com enum em vez de três vizinhas (recall 100% → 50%). O corte é
 * por `prioridade` declarada, e o fato vai para o log: um corte silencioso
 * viraria "a feature não funciona às vezes".
 */
export const TETO_DE_TOOLS = 5;

const PEDE_NEGOCIO =
  /\b(neg[oó]cio|neg[oó]cios|processo|andamento|etapa|status|carteira|pend[eê]ncia|pendencias|falta|faltando|certid\w*|documentos?)\b/i;

export const LISTAR_NEGOCIOS: ToolDef = {
  capability: "deal.list",
  verb: "deal.list",
  prioridade: 10,
  combina: (t) => PEDE_NEGOCIO.test(normalizar(t)),
  def: {
    name: "listar_negocios",
    /**
     * A descrição é o que decide a chamada — mais que o prompt. Fala do que a
     * PESSOA quer ("meus negócios", "como está o processo"), não do que a rota
     * faz: o modelo casa intenção com intenção, não com encanamento.
     */
    description:
      "Lista os negócios em que esta pessoa está envolvida, com a etapa de cada um. " +
      "Use quando ela perguntar sobre os negócios dela, o andamento ou a etapa, " +
      "ou pedir um resumo da carteira. Para saber só o que está pendente, use " +
      "pendencias_do_negocio. Não use para perguntas gerais sobre como o processo funciona.",
    parameters: {
      type: "object",
      properties: {
        estado: {
          type: "string",
          description: "Filtra por etapa, quando a pessoa nomear uma. Opcional.",
        },
        limite: {
          type: "integer",
          description: "Quantos negócios trazer. Padrão 10.",
        },
      },
      additionalProperties: false,
    },
  },
};

const PEDE_PENDENCIA =
  /\b(pend[eê]ncia|pendencias|pendente|pendentes|falta|faltando|faltam|travad[oa]|parad[oa]|certid\w*|documentos?)\b/i;

/**
 * Os negócios desta pessoa que TÊM pendência — o servidor filtra no `where`
 * (`deal.pending`), então `limite` conta negócios pendentes, não varridos.
 *
 * Tool própria, e não um filtro da `listar_negocios`, porque é a capability que
 * o `brokerDefault` concede ao corretor comissionado: a pergunta dele é "falta
 * algo nos meus negócios?", sem apontar negócio nenhum.
 */
export const PENDENCIAS_DO_NEGOCIO: ToolDef = {
  capability: "deal.pending",
  verb: "deal.pending",
  prioridade: 20,
  combina: (t) => PEDE_PENDENCIA.test(normalizar(t)),
  def: {
    name: "pendencias_do_negocio",
    description:
      "Lista só os negócios desta pessoa que têm alguma pendência, e quais são. " +
      "Use quando ela perguntar o que falta, o que está pendente ou travado, " +
      "ou se algum negócio dela precisa de algo.",
    parameters: {
      type: "object",
      properties: {
        limite: {
          type: "integer",
          description: "Quantos negócios trazer. Padrão 10.",
        },
      },
      additionalProperties: false,
    },
  },
};

const PEDE_PROPOSTA = /\b(proposta|propostas)\b/i;

/**
 * Pedido de CRIAÇÃO de documento — terreno da `propor_criacao`, não das
 * leituras. Em pedido de criação, NENHUMA tool de leitura entra no turn.
 *
 * Medido na eval (2026-09-22): com `listar_propostas` oferecida ao lado, o nano
 * deixou de propor a criação em "cria uma proposta pro Carlos" (recall da
 * `propor_criacao` 93% → 33%). A vizinha roubava a decisão.
 *
 * ANCORADO no objeto, e não em verbo solto (achado do review do #37): "faz",
 * "abre" e "nova" sozinhos casavam "faz quanto tempo a proposta foi
 * enviada?", "abre a proposta do Carlos" e "tem proposta nova?" — tirando a
 * leitura e deixando SÓ a tool de escrita para uma consulta. O que distingue
 * criação é verbo (ou "preciso de"/"quero") + artigo INDEFINIDO (ou nenhum) +
 * o documento: "cria uma proposta", "preciso de um formulário", "monta
 * proposta". "A proposta" (definido) é algo que já existe: consulta.
 */
const PEDE_CRIACAO =
  /\b(?:(?:cri[ae]r?|crie|mont[ae]r?|abr[ae]|abrir|fa[zc]a?|fazer|ger[ae]r?|manda?r?|envi[ae]r?)|(?:preciso|precisava|quero|queria|gostaria)(?:\s+de)?(?:\s+(?:criar|fazer|montar|abrir|gerar|mandar|enviar))?)\s+(?:(?:uma|um)\s+)?(?:(?:nova|novo)\s+)?(?:rascunho\s+de\s+)?(?:proposta|formulario|ficha|cadastro)\b/i;

/**
 * Criação SEM verbo, só no INÍCIO do texto: "proposta nova pro João", "novo
 * formulário de locação". Ancorado no começo de propósito — "tem proposta
 * nova?" (consulta) começa com "tem" e fica fora (re-review do #37).
 */
const PEDE_CRIACAO_SEM_VERBO =
  /^(?:(?:uma|um)\s+)?(?:(?:nova|novo)\s+(?:proposta|formulario|ficha|cadastro)|(?:proposta|formulario|ficha|cadastro)\s+(?:nova|novo))\b/i;

/** O texto é um pedido de criação de documento? (Normalizado: sem acento.) */
export function ehPedidoDeCriacao(texto: string): boolean {
  const n = normalizar(texto);
  return PEDE_CRIACAO.test(n) || PEDE_CRIACAO_SEM_VERBO.test(n);
}

/**
 * As propostas que esta pessoa enxerga no sistema — o `proposalScopeWhere` do
 * servidor decide quais (as dela ou as da org, conforme o papel). Corretor
 * comissionado sem login recebe lista vazia: proposta se liga a `User`.
 */
export const LISTAR_PROPOSTAS: ToolDef = {
  capability: "proposal.list",
  verb: "proposal.list",
  prioridade: 30,
  combina: (t) => PEDE_PROPOSTA.test(normalizar(t)),
  def: {
    name: "listar_propostas",
    description:
      "Lista as propostas que esta pessoa acompanha, com o status de cada uma. " +
      "Use quando ela perguntar pelas propostas dela, se uma proposta foi aceita, " +
      "assinada, recusada ou expirou. Não use para CRIAR proposta.",
    parameters: {
      type: "object",
      properties: {
        estado: {
          type: "string",
          description:
            "Filtra por status, só quando a pessoa pedir um. Valores: rascunho, " +
            "aguardando_aprovacao, enviada, entregue, visualizada, assinada_proponente, " +
            "aguardando_vendedor, completa, convertida, recusada_proponente, " +
            "recusada_vendedor, expirada, cancelada, falha_envio.",
        },
        limite: {
          type: "integer",
          description: "Quantas propostas trazer. Padrão 10.",
        },
      },
      additionalProperties: false,
    },
  },
};

/**
 * O catálogo de LEITURA. As de escrita seguem fora — ver `selecionarTools`.
 *
 * `deal.detail` e `proposal.detail` NÃO têm tool (2026-09-22): no servidor
 * eles devolvem exatamente os campos da listagem, só filtrando por id. Uma
 * tool "detalhar" não traria informação nova e seria uma vizinha a mais para
 * o nano confundir — a medição que fez `propor_criacao` ser uma tool só.
 * Entram quando o servidor tiver projeção de detalhe mais rica.
 */
export const TOOLS_DE_LEITURA: ToolDef[] = [LISTAR_NEGOCIOS, PENDENCIAS_DO_NEGOCIO, LISTAR_PROPOSTAS];

/**
 * Quais tools entram no prompt deste turn.
 *
 * ── ⚠️ Por que `propor_criacao` NÃO passa por aqui ────────────────────────
 *
 * Ela é oferecida por `podeEscrever(identity) && shouldOfferTools(texto)`, SEM
 * consultar a política — exatamente como antes deste PR. Gateá-la agora a faria
 * exigir `form.create`, que **nenhuma org concede** (não existe editor nem rota
 * de escrita da política), e o Max **pararia de propor formulário em produção**,
 * em silêncio. Seria regressão da única capability que ele exerce hoje — o
 * cenário que a mensagem do PR 4 descreve como "regressão, não inércia".
 *
 * O gate dela entra no PR 6c, junto do editor que torna `form.create`
 * concedível. Os dois testes de `policy.test.ts` que trancam isso continuam
 * verdes sem alteração, e é assim que tem que ser.
 *
 * ── A fórmula ─────────────────────────────────────────────────────────────
 *
 *   tools = catálogo ∩ capabilities efetivas ∩ prefiltro
 *
 * O prefiltro é **generoso de propósito**: falso positivo custa tokens, falso
 * negativo custa a feature.
 */
export function selecionarTools(params: {
  policy: Capability[];
  texto: string;
  catalogo?: ToolDef[];
}): { tools: ToolDef[]; cortadas: number } {
  const catalogo = params.catalogo ?? TOOLS_DE_LEITURA;
  const texto = params.texto;

  // Pedido de criação é da `propor_criacao`: leitura ao lado rouba a decisão
  // do nano (ver `PEDE_CRIACAO`). Nenhuma leitura entra nesse turn — inclusive
  // em texto misto ("cria uma proposta e me diz como estão meus negócios"),
  // que perde a leitura NESTE turn. Troca deliberada: a criação é a única
  // escrita do Max, e a consulta pode ser refeita na mensagem seguinte.
  if (ehPedidoDeCriacao(texto)) return { tools: [], cortadas: 0 };

  const elegiveis = catalogo
    .filter((t) => params.policy.includes(t.capability))
    .filter((t) => t.combina(texto))
    .sort((a, b) => a.prioridade - b.prioridade);

  if (elegiveis.length <= TETO_DE_TOOLS) {
    return { tools: elegiveis, cortadas: 0 };
  }
  return {
    tools: elegiveis.slice(0, TETO_DE_TOOLS),
    cortadas: elegiveis.length - TETO_DE_TOOLS,
  };
}
