import { nomeDoAgente } from "@/lib/deploy-profile";
import { featureEnabled } from '@/lib/runtime/rollout';
import type { LlmTool } from "@/lib/llm";
import type { Capability } from "./policy";
import type { ScopeQueryVerb } from "./scope-contract";
import { ESTADOS_DE_PROPOSTA } from "./scope-contract";
import type { Candidate } from "@/lib/identity";
import { captacaoLigada } from "./captacao-flags";
import { packsDoPerfil, type ToolPack } from "@/packs";

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
 * `proposta` é um RASCUNHO de proposta + link; `captacao` (P9) abre o fluxo de
 * captação (rascunho de contrato de captação) e SÓ vale com `MAX_CAPTACAO`:
 * desligada, o modelo nem vê o valor no enum e `capabilityDaCriacao` o recusa.
 */
export const TIPOS_CRIAVEIS = ["venda", "locacao", "proposta", "captacao"] as const;
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
const TIPOS_SEM_CAPTACAO = TIPOS_CRIAVEIS.filter((t) => t !== "captacao");

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
    "dê detalhes. Não use para converter, transformar ou continuar uma proposta " +
    "existente, nem para gerar um formulário a partir dela: isso exige preservar " +
    "o vínculo com a proposta. A criação não acontece agora: a pessoa ainda confirma depois.",
  parameters: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: TIPOS_SEM_CAPTACAO,
        description:
          "venda = formulário de compra e venda (comprador, imóvel à venda). " +
          "locacao = formulário de aluguel (inquilino, locação, locatário). " +
          "proposta = rascunho de proposta comercial, de venda OU de aluguel — " +
          "pedido com a palavra 'proposta' é deste tipo; aluguel vai em natureza.",
      },
      nome_cliente: {
        type: "string",
        description:
          "Nome do CLIENTE (comprador, inquilino, proponente) que a pessoa citou " +
          "— 'compradora Letícia Souza' → 'Letícia Souza'. Nunca o nome de quem " +
          "está falando com você. Omita se ela não citou — não invente nem deduza.",
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

/**
 * A definição que o modelo VÊ neste turno: com `MAX_CAPTACAO` ligada, o enum
 * ganha `captacao`; desligada, é o `FORM_TOOL` de antes do P9, byte a byte.
 */
export function formToolAtual(): LlmTool {
  if (!captacaoLigada()) return FORM_TOOL;
  const params = FORM_TOOL.parameters as { properties: { tipo: { description: string } } };
  return {
    ...FORM_TOOL,
    parameters: {
      ...FORM_TOOL.parameters,
      properties: {
        ...params.properties,
        tipo: {
          ...params.properties.tipo,
          enum: [...TIPOS_CRIAVEIS],
          description:
            `${params.properties.tipo.description} ` +
            "captacao = contrato de captação (autorização do proprietário para vender ou alugar o imóvel); " +
            "pedido com a palavra 'captação' é deste tipo.",
        },
      },
    },
  };
}

/** Lê o `tipo` da chamada do modelo. `null` quando ele mandou algo fora do enum (ou `captacao` com a flag desligada). */
export function lerTipo(bruto: unknown): TipoCriavel | null {
  if (bruto === "captacao" && !captacaoLigada()) return null;
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
export function normalizar(texto: string): string {
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

/**
 * G6 — a pessoa quer o resto da resposta cortada?
 *
 * Casamento ANCORADO, e com lista PRÓPRIA, mais estreita que a do
 * `lerConfirmacao` (achado do review de segurança do PR 2): "ok", "beleza",
 * "certo", "👍", "tá", "vai" são o jeito de ENCERRAR um assunto no WhatsApp,
 * não de pedir mais — aceitá-los mandava um segundo bloco a quem só agradeceu.
 * Só "sim"/"s" (a resposta à pergunta que fizemos) e frases que pedem
 * continuação explicitamente. Só é consultado quando há resto guardado.
 */
const QUER_O_RESTO =
  /^(sim|s|quero( ver)?( o resto| mais)?|continua|continue|continuar|mais|o resto|resto|ver o resto|manda o resto|pode mandar( o resto)?|manda mais)$/;

export function querVerOResto(texto: string): boolean {
  const t = normalizar(texto);
  if (!t) return false;
  return QUER_O_RESTO.test(t);
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
  captacao: "rascunho de captação",
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
 * A política desta org não concede a criação pedida (G4).
 *
 * Diz que NADA foi criado e de quem é a decisão: "tenta de novo" mandaria a
 * pessoa bater na mesma parede, como no módulo desligado.
 */
export function textoSemPermissao(args: Pick<PendingAction["args"], "tipo" | "natureza" | "finalidade">): string {
  return (
    `Criar ${descreverPendencia(args)} pelo ${nomeDoAgente()} não está liberado para você. ` +
    "Nada foi criado. Dá pra fazer pelo sistema, ou fala com quem administra a conta."
  );
}

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
 * O REGISTRO de tools — uma entrada declarativa por tool, leitura ou escrita.
 *
 * Antes eram dois mundos: as leituras num `ToolDef` passado pela política, e a
 * `propor_criacao` solta no `graph.ts`, oferecida sem política e tratada à mão.
 * Duas portas de entrada são duas listas de checagem que divergem no primeiro
 * ajuste — e a próxima tool de escrita (PR 6: enviar, cancelar, recriar
 * proposta) é exatamente a que não pode cair na porta sem checagem. Agora:
 * **tool nova = uma entrada aqui + o executor + os casos da eval**, e o
 * despachante (`despachante.ts`) aplica as mesmas travas a qualquer uma.
 *
 * `capability` é o que a política governa; `verbo` é o que o servidor
 * executa. Separados de propósito — a política diz o que se pode OFERECER, o
 * servidor decide o que VOLTA. Confundir os dois produz vazamento que nenhum
 * teste deste repo pega (`docs/max.md` §11.4).
 */
interface EntradaBase {
  /** Igual a `def.name` — o teste do registro confere. */
  nome: string;
  def: LlmTool;
  /** Menor = entra primeiro quando o teto de 5 corta. */
  prioridade: number;
  /** Prefiltro barato por intenção. Generoso de propósito — ver abaixo. */
  combina: (texto: string) => boolean;
}

/**
 * O que a lista de uma leitura PRODUZ, para as referências numeradas (G2):
 * o código numera os itens e guarda número → id; o modelo só vê o número.
 */
export type TipoDeReferencia = "negocio" | "proposta" | "imovel" | "atividade" | "notificacao" | "contrato";

export interface EntradaDeLeitura extends EntradaBase {
  tipo: "leitura";
  capability: Capability;
  verb: ScopeQueryVerb;
  /** Leitura não muda nada, não custa nada e não pede confirmação. */
  risco: "nenhum";
  confirmacao: false;
  refs?: { produz?: TipoDeReferencia };
}

/**
 * Escrita: a capability pode depender dos ARGUMENTOS — `propor_criacao` cria
 * formulário (`form.create`) ou proposta (`proposal.create`) conforme o
 * `tipo`. Por isso duas perguntas separadas:
 *  - `capabilities`: a OFERTA — basta a política conceder uma delas para a
 *    tool entrar no prompt;
 *  - `capabilityDaChamada`: a EXECUÇÃO — o que ESTA chamada exige. `null` =
 *    argumento inválido, e chamada inválida é descartada, nunca adivinhada.
 *
 * `confirmacao: true` é a G3: a tool só REGISTRA a pendência; quem executa é o
 * `confirm`, no turn seguinte, depois do "sim" — e ele passa de novo pelo
 * despachante, porque a política pode ter mudado entre os dois turns.
 */
export interface EntradaDeEscrita extends EntradaBase {
  tipo: "escrita";
  capabilities: readonly Capability[];
  capabilityDaChamada: (args: Record<string, unknown>) => Capability | null;
  /** O verbo no servidor coincide com a capability da chamada (plano, PR 1). */
  risco: "nenhum" | "pago" | "irreversivel";
  confirmacao: boolean;
  refs?: { consome?: TipoDeReferencia; produz?: TipoDeReferencia };
}

export type EntradaDeTool = EntradaDeLeitura | EntradaDeEscrita;

/**
 * Nome antigo, mantido: era o tipo das tools de leitura e os testes da
 * seleção montam catálogos falsos com ele.
 */
export type ToolDef = EntradaDeLeitura;

/** Todas as capabilities que podem fazer uma entrada ser OFERECIDA. */
export function capabilitiesDeOferta(e: EntradaDeTool): readonly Capability[] {
  return e.tipo === "leitura" ? [e.capability] : e.capabilities;
}

/**
 * A capability que a CRIAÇÃO exige, pelo `tipo`.
 *
 * Proposta é `proposal.create`; formulário de venda ou de locação é
 * `form.create` (o formulário nasce junto de um negócio — é o "form.create"
 * do catálogo do ImobPro, que o `POLITICA_PADRAO` concede a todo papel).
 * `tipo` fora do enum → `null`: o despachante descarta, não adivinha.
 */
export function capabilityDaCriacao(tipo: unknown): Capability | null {
  const t = lerTipo(tipo);
  if (!t) return null;
  // `captacao` só existe com `MAX_CAPTACAO` (`lerTipo` já devolve null sem ela).
  if (t === "captacao") return "captacao.create";
  return t === "proposta" ? "proposal.create" : "form.create";
}

export const PROPOR_CRIACAO: EntradaDeEscrita = {
  nome: TOOL_PROPOR_FORM,
  // Getter: a definição acompanha a flag `MAX_CAPTACAO` do momento (default: o `FORM_TOOL` de sempre).
  get def() { return formToolAtual(); },
  tipo: "escrita",
  capabilities: ["form.create", "proposal.create"],
  capabilityDaChamada: (args) => capabilityDaCriacao(args.tipo),
  // Rascunho/formulário em branco: nada é cobrado nem apagado. A confirmação
  // existe porque é escrita no tenant, não porque custa.
  risco: "nenhum",
  confirmacao: true,
  // Fora do teto de leitura: ela não compete por vaga com as leituras, é
  // somada à parte (ver `TETO_DE_TOOLS`).
  prioridade: 0,
  combina: (t) => shouldOfferTools(t),
};

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
  /\b(neg[oó]cio|neg[oó]cios|vendas|processo|andamento|etapa|status|carteira|pend[eê]ncia|pendencias|falta|faltando|certid\w*|documentos?)\b/i;

export const LISTAR_NEGOCIOS: ToolDef = {
  nome: "listar_negocios",
  tipo: "leitura",
  capability: "deal.list",
  verb: "deal.list",
  risco: "nenhum",
  confirmacao: false,
  refs: { produz: "negocio" },
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
  nome: "pendencias_do_negocio",
  tipo: "leitura",
  capability: "deal.pending",
  verb: "deal.pending",
  risco: "nenhum",
  confirmacao: false,
  refs: { produz: "negocio" },
  prioridade: 20,
  combina: (t) => PEDE_PENDENCIA.test(normalizar(t)),
  def: {
    name: "pendencias_do_negocio",
    description:
      "Lista só os negócios desta pessoa que têm certidão ou documento pendente ou travado " +
      "no processo, e quais são. Use quando ela perguntar por certidões, documentos ou " +
      "pendências de um negócio. Para formulários, propostas e atividades pendentes dela, " +
      "use minhas_pendencias.",
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

/**
 * Formulário, proposta ou atividade JUNTO de "pendente"/"falta": "o que falta no
 * formulário do negócio X", "tem atividade faltando?". Sozinhas, as palavras
 * são de outras tools (`listar_propostas`, `listar_atividades`).
 */
const PEDE_ITEM_PENDENTE = /formul[aá]rio|proposta|atividade/i;
const PEDE_FALTA = /pendent|pend[eê]ncia|falta(m|ndo)?\b/i;
/**
 * A pergunta genérica, sem nomear o item: "o que tenho pendente?", "minhas
 * pendências". Ancorada na PESSOA (tenho/minhas/comigo) de propósito: "certidões
 * pendentes" ou "o que falta no negócio" são da `pendencias_do_negocio`.
 */
const PEDE_MINHAS_GENERICA =
  /\bo que (eu )?tenho( de| para| pra)? (pendente|pendentes|pendencias?)|\bminhas? pendencias?\b|\b(tenho|temos) (algo|alguma coisa|alguma pendencia|pendencias?)\b|\bo que (esta |ta )?pendente (comigo|pra mim|para mim)/i;

/**
 * "O que tenho pendente": formulários, propostas e atividades DESTA pessoa num
 * só verbo (`pending.summary`). O servidor decide o escopo por papel e devolve
 * total exato + até 5 itens por bloco; o motor não conta nem recorta nada.
 *
 * Prioridade 15, antes da `pendencias_do_negocio` (20): a pergunta genérica
 * "o que tenho pendente?" é desta tool; certidões e documentos do negócio
 * continuam na outra (a descrição de cada uma aponta para a vizinha).
 *
 * Params: `filtro` vira `blocos` (um bloco) e `negocio_id` vira `dealId` no
 * despachante — o modelo nunca fala o nome de campo do servidor.
 */
export const MINHAS_PENDENCIAS: ToolDef = {
  nome: "minhas_pendencias",
  tipo: "leitura",
  capability: "pending.summary",
  verb: "pending.summary",
  risco: "nenhum",
  confirmacao: false,
  prioridade: 15,
  combina: (t) => {
    const n = normalizar(t);
    return PEDE_MINHAS_GENERICA.test(n) || (PEDE_ITEM_PENDENTE.test(n) && PEDE_FALTA.test(n));
  },
  def: {
    name: "minhas_pendencias",
    description:
      "Resume o que está pendente com esta pessoa: formulários a preencher, propostas " +
      "e atividades, cada bloco com o total exato e alguns itens. Use quando ela " +
      "perguntar o que tem pendente, o que falta no formulário de um negócio, ou " +
      "por formulários, propostas ou atividades pendentes. Sem filtro, traz os três " +
      "blocos; com filtro, só o bloco pedido. Para certidões e documentos de um " +
      "negócio, use pendencias_do_negocio.",
    parameters: {
      type: "object",
      properties: {
        filtro: {
          type: "string",
          enum: ["formularios", "propostas", "atividades"],
          description: "Só o bloco pedido. Omita quando a pergunta for geral. Opcional.",
        },
        negocio_id: {
          type: "string",
          description:
            "Restringe aos formulários de um negócio, só se o identificador veio num resultado anterior desta ferramenta. Opcional.",
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
  nome: "listar_propostas",
  tipo: "leitura",
  capability: "proposal.list",
  verb: "proposal.list",
  risco: "nenhum",
  confirmacao: false,
  refs: { produz: "proposta" },
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
            "Filtra por status, só quando a pessoa pedir um. Valores: " +
            `${ESTADOS_DE_PROPOSTA.join(", ")}.`,
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
const EXTENDED_READS: Array<{nome:string;verb:ScopeQueryVerb;pattern:RegExp;description:string;required?:string[];capability?:Capability;props?:Record<string,unknown>}> = [
 {nome:"listar_notificacoes",verb:"notification.list",pattern:/notific|avisos?/i,description:"Lista metadados das notificações desta pessoa, sem corpo nem título privado."},
 {nome:"listar_atividades",verb:"activity.list",pattern:/atividades?|tarefas?|agenda|atrasad/i,description:"Lista atividades autorizadas. estado: abertas, atrasadas, hoje, 7d ou concluidas. filtro: minhas, atrasadas ou hoje (recorte do servidor).",props:{filtro:{type:"string",enum:["minhas","atrasadas","hoje"],description:"Recorte pedido: só as minhas, só as atrasadas ou só as de hoje. Opcional."}}},
 {nome:"ver_atividade",verb:"activity.get",capability:"activity.list",pattern:/atividades?|tarefas?|agenda|atrasad/i,description:"Mostra uma atividade com notas, responsáveis e comentários, escolhida pelo número da lista de atividades anterior. Se não houver lista, use listar_atividades primeiro.",required:["numero"]},
 {nome:"resumo_carteira",verb:"metrics.get",pattern:/resumo|quantos|quantas|metric|m[eé]trica|carteira/i,description:"Conta negócios, propostas e contratos visíveis desta pessoa, sem dados financeiros."},
 {nome:"listar_imoveis",verb:"property.list",pattern:/im[oó]ve[il]|apartament|casas?|propriedad/i,description:"Lista imóveis autorizados com características públicas. Nunca revela proprietário, endereço completo ou preço de terceiro."},
 {nome:"detalhar_imovel",verb:"property.detail",pattern:/im[oó]vel|apartament|propriedad/i,description:"Consulta características atuais de imóvel autorizado selecionado pelo número da lista de imóveis anterior.",required:["numero"]},
 {nome:"decisoes_pendentes_modelos",verb:"template.decisions",pattern:/decis[aã]o|decis[oõ]es|pol[ií]tica d[ao]s? modelos?|modelos? de contrato/i,description:"Lista as decisões da imobiliária que ainda esperam resposta nos modelos de contrato: o rótulo de cada uma, quantos modelos ela afeta e o link da tela onde o dono ou admin decide. naoMedidos = modelos ainda sem relatório: diga que não foram medidos, nunca que não há pendência. Só leitura: nada é decidido por aqui."},
 {nome:"situacao_contrato",verb:"contract.status",pattern:/contrat|assinatur/i,description:"Consulta estado e versão do contrato de negócio autorizado. Use numero da lista de negócios; se não houver lista, consulte listar_negocios primeiro. Não retorna corpo nem signatários do contrato.",required:["numero"]},
];
export const TOOLS_EXTENDIDAS: ToolDef[] = EXTENDED_READS.map((e,index)=>({nome:e.nome,tipo:"leitura",capability:e.capability??(e.verb as Capability),verb:e.verb,risco:"nenhum",confirmacao:false,...(e.verb!=="metrics.get"&&e.verb!=="template.decisions"?{refs:{produz:(e.verb.startsWith("property.")?"imovel":e.verb.startsWith("activity.")?"atividade":e.verb.startsWith("notification.")?"notificacao":"contrato") as TipoDeReferencia}}:{}),prioridade:40+index,combina:(text)=>process.env.MAX_EXTENDED_QUERIES==="true"&&e.pattern.test(text),def:{name:e.nome,description:e.description,parameters:{type:"object",properties:{mais:{type:"boolean",description:"Continua a última página desta lista; o servidor controla o cursor. Use quando a pessoa pedir mais resultados."},estado:{type:"string"},...(e.props??{}),numero:{type:"integer",minimum:1,description:"Número exibido na lista anterior, nunca um ID interno."}},required:e.required??[],additionalProperties:false}}}));
/**
 * Atividades v2 (M1): as quatro escritas. Todas exigem `activity.write` (fora do padrão: a org liga),
 * identidade de USUÁRIO (`podeEscrever`) e confirmação humana. A tool só REGISTRA o pedido: o
 * fluxo determinístico (`atividades.ts`) mostra o resumo, espera o "sim" e só então chama o verbo,
 * com a `messageId` do "sim" como `x-idempotency-key`. O modelo NUNCA vê ids: aponta pelo `numero`
 * da lista anterior (atividades; negócios, no `criar_atividade`). Ninguém é cobrado nem contatado:
 * é atividade INTERNA da imobiliária.
 */
const PALAVRA_DE_ATIVIDADE = /\b(atividades?|tarefas?|pendencias?|lembretes?|agenda|compromissos?)\b/;
// Verbo solto ("conclui a 2", depois de uma lista) só vale sem OUTRO objeto na frase: "a proposta foi recusada" não é atividade.
const OUTRO_OBJETO = /\b(propostas?|contratos?|formularios?|fichas?|cobrancas?|captacoes?|captacao|assinaturas?|credito|certidoes?|certidao)\b/;
const VERBO_DE_ATIVIDADE_SOLTO = /\b(conclu\w*|finaliz\w*|recus\w*|coment\w*)\b/;
export function pedeAtividade(texto: string): boolean {
  const t = normalizar(texto);
  return PALAVRA_DE_ATIVIDADE.test(t) || (VERBO_DE_ATIVIDADE_SOLTO.test(t) && !OUTRO_OBJETO.test(t));
}
const NUMERO_DA_ATIVIDADE = {
  type: "integer",
  minimum: 1,
  description: "Número da atividade na lista exibida antes, nunca um ID interno.",
} as const;

function escritaDeAtividade(
  nome: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  prioridade: number,
  consome: TipoDeReferencia
): EntradaDeEscrita {
  return {
    nome,
    tipo: "escrita",
    capabilities: ["activity.write"],
    capabilityDaChamada: () => "activity.write",
    risco: "nenhum",
    confirmacao: true,
    refs: { consome },
    prioridade,
    combina: (t) => pedeAtividade(t),
    def: { name: nome, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  };
}

export const CRIAR_ATIVIDADE = escritaDeAtividade(
  "criar_atividade",
  "Propõe criar uma atividade interna (ligação, visita, reunião, documento, pendência) num negócio da pessoa. " +
    "Só registra o pedido: a pessoa confirma com 'sim' antes de qualquer coisa ser criada. Não contata cliente nem parte. " +
    "Use numero da lista de negócios; se não houver lista, consulte listar_negocios primeiro.",
  {
    numero: { type: "integer", minimum: 1, description: "Número do negócio na lista de negócios anterior, nunca um ID interno." },
    tipo: { type: "string", enum: ["ligacao", "visita", "reuniao", "documento", "pendencia", "outro"] },
    titulo: { type: "string", description: "Título curto, até 140 caracteres." },
    vencimento: { type: "string", description: "Quando vence: data AAAA-MM-DD ou data e hora ISO com fuso. Só o que a pessoa disse." },
    notas: { type: "string", description: "Observação opcional." },
  },
  ["numero", "tipo", "titulo", "vencimento"],
  1,
  "negocio"
);

export const COMENTAR_ATIVIDADE = escritaDeAtividade(
  "comentar_atividade",
  "Propõe comentar numa atividade. Só registra o pedido; a pessoa confirma com 'sim'. " +
    `Se ela não disse o texto, deixe texto vazio: o ${nomeDoAgente()} pergunta.`,
  { numero: NUMERO_DA_ATIVIDADE, texto: { type: "string", description: "O comentário, como a pessoa disse. Opcional." } },
  ["numero"],
  2,
  "atividade"
);

export const CONCLUIR_ATIVIDADE = escritaDeAtividade(
  "concluir_atividade",
  "Propõe marcar uma atividade como concluída. Só registra o pedido; a pessoa confirma com 'sim'.",
  { numero: NUMERO_DA_ATIVIDADE },
  ["numero"],
  3,
  "atividade"
);

export const RECUSAR_ATIVIDADE = escritaDeAtividade(
  "recusar_atividade",
  "Propõe recusar uma atividade atribuída à pessoa, devolvendo-a a quem a passou. Precisa de motivo (mín. 3 caracteres). " +
    `Só registra o pedido; a pessoa confirma com 'sim'. Se ela não disse o motivo, deixe motivo vazio: o ${nomeDoAgente()} pergunta.`,
  { numero: NUMERO_DA_ATIVIDADE, motivo: { type: "string", description: "Por que recusa, como a pessoa disse. Opcional." } },
  ["numero"],
  4,
  "atividade"
);

export const TOOLS_DE_ATIVIDADE_ESCRITA: EntradaDeEscrita[] = [
  CRIAR_ATIVIDADE,
  COMENTAR_ATIVIDADE,
  CONCLUIR_ATIVIDADE,
  RECUSAR_ATIVIDADE,
];

export const TOOLS_DE_LEITURA: ToolDef[] = [LISTAR_NEGOCIOS, MINHAS_PENDENCIAS, PENDENCIAS_DO_NEGOCIO, LISTAR_PROPOSTAS, ...TOOLS_EXTENDIDAS];

/**
 * O registro inteiro: a escrita e as leituras. É a ÚNICA lista que o
 * despachante consulta — nome fora daqui é `tool_desconhecida`.
 */
export const REGISTRO_DE_TOOLS: EntradaDeTool[] = [PROPOR_CRIACAO, ...TOOLS_DE_ATIVIDADE_ESCRITA, ...TOOLS_DE_LEITURA];

/** O registro deste deploy: o núcleo mais as entradas dos packs do perfil (`src/packs`). */
export function entradasDoDeploy(packs: readonly ToolPack[] = packsDoPerfil()): EntradaDeTool[] {
  const todas = [...REGISTRO_DE_TOOLS, ...packs.flatMap((p) => p.entradas)];
  // Nome repetido faria o `find` do despachante escolher uma das duas em
  // silêncio; o pack que colide com o núcleo não pode subir.
  if (packs.length) {
    const vistos = new Set<string>();
    for (const e of todas) {
      if (vistos.has(e.nome)) throw new Error(`tool_nome_duplicado: ${e.nome}`);
      vistos.add(e.nome);
    }
  }
  return todas;
}

export function buscarNoRegistro(nome: string, packs?: readonly ToolPack[]): EntradaDeTool | undefined {
  return entradasDoDeploy(packs).find((e) => e.nome === nome);
}

/**
 * O catálogo, por NOME.
 *
 * Existe para o sanitizador da saída (`compose.ts`) saber o que nunca pode
 * aparecer na conversa. Derivado do registro, e não escrito à mão: é o que faz
 * a tool que o PR 6 acrescentar nascer bloqueada sem ninguém lembrar de editar
 * dois arquivos.
 */
export const NOMES_DE_TOOL: string[] = entradasDoDeploy().map((e) => e.nome);

/**
 * Quais tools de LEITURA entram no prompt deste turn.
 *
 * A `propor_criacao` não passa por aqui porque não disputa o teto das
 * leituras — ela é somada por `ferramentasDoTurno`, que agora também a
 * passa pela política (PR 2 do plano de 05/10; antes era oferecida sem
 * política, enquanto `form.create` não era concedível).
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
  orgId?: string;
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
    .filter(t => !TOOLS_EXTENDIDAS.includes(t) || featureEnabled("queries",params.orgId))
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

/**
 * TUDO que entra no prompt deste turn — escrita e leitura —, já cruzado com a
 * política e com a identidade (G4).
 *
 * A escrita entra se: quem fala PODE escrever (`podeEscrever`: corretor sem
 * login nunca), a política concede ao menos uma das capabilities dela, e o
 * prefiltro casa. **Política ausente ou perfil fora do ar = sem escrita** —
 * fail-closed, e é o que os testes trancados de `policy.test.ts` afirmam desde
 * este PR.
 *
 * A ordem `[...escrita, ...leitura]` é a de sempre: para um nano a posição da
 * vizinha pesa, e a eval mede nesta ordem.
 *
 * ── `textoAnterior`: o pedido de criação atravessa UMA resposta ───────────
 *
 * Conversa real de 2026-10-06: "Pode gerar uma proposta pra mim?" → o Max
 * perguntou "venda ou locação?" (como o prompt manda) → "Venda". O prefiltro
 * olhava só "Venda", não casava, e a ferramenta SUMIU do turn em que era
 * finalmente chamável. Sem ela, o nano improvisou cinco turns colhendo
 * endereço, valor e forma de pagamento e terminou com "proposta criada" —
 * nada foi criado. O pedido que o Max deixou em aberto com uma pergunta
 * (`pedidoEmAberto`) conta para a ESCRITA — só ela: a leitura não tem pergunta
 * de desambiguação no meio. Continua exigindo política e identidade, e a
 * criação continua exigindo o "sim".
 */
/** Data de hoje (America/Sao_Paulo, AAAA-MM-DD) e o fuso: o modelo não tem relógio. */
export function dataDeHojeEmSaoPaulo(agora: number = Date.now()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(agora));
}

/** Só `criar_atividade` muda por turno: a descrição do `vencimento` ganha a data de hoje e o fuso. */
function comDataDeHoje(e: EntradaDeEscrita, agora?: number): EntradaDeEscrita {
  if (e.nome !== "criar_atividade") return e;
  const params = e.def.parameters as { properties: Record<string, { description?: string }> };
  const venc = params.properties.vencimento;
  if (!venc) return e;
  const hoje = dataDeHojeEmSaoPaulo(agora);
  return {
    ...e,
    def: { ...e.def, parameters: { ...params, properties: { ...params.properties, vencimento: {
      ...venc,
      description: `${venc.description ?? ""} Hoje é ${hoje} (America/Sao_Paulo, fuso -03:00). Converta "amanhã", "sexta" etc. a partir dessa data; com hora, use o fuso -03:00 (ex.: ${hoje}T14:00:00-03:00).`.trim(),
    } } } },
  };
}

export function ferramentasDoTurno(params: {
  policy: Capability[];
  texto: string;
  identity: Candidate;
  /** O pedido que o Max deixou em aberto com uma pergunta (`pedidoEmAberto`). */
  textoAnterior?: string | null;
  /** Relógio do turno (testes); o padrão é agora. Alimenta a data na descrição do `vencimento`. */
  agora?: number;
  /** Packs do perfil (testes); o padrão é `packsDoPerfil()`. */
  packs?: readonly ToolPack[];
}): { entradas: EntradaDeTool[]; cortadas: number } {
  const registro = entradasDoDeploy(params.packs);
  const escrita = registro.filter(
    (e): e is EntradaDeEscrita =>
      e.tipo === "escrita" &&
      escritaPermitida(e, params.identity, params.policy) &&
      (e.combina(params.texto) || (!!params.textoAnterior && e.combina(params.textoAnterior)))
  );
  const leiturasDosPacks = registro.filter(
    (e): e is EntradaDeLeitura => e.tipo === "leitura" && !TOOLS_DE_LEITURA.includes(e)
  );
  const leitura = selecionarTools({
    policy: params.policy,
    texto: params.texto,
    orgId: params.identity.orgId,
    catalogo: leiturasDosPacks.length ? [...TOOLS_DE_LEITURA, ...leiturasDosPacks] : undefined,
  });
  return { entradas: [...escrita.map((e) => comDataDeHoje(e, params.agora)), ...leitura.tools], cortadas: leitura.cortadas };
}

/**
 * O pedido da pessoa que o Max deixou EM ABERTO com uma pergunta.
 *
 * Só vale quando a última mensagem do fio é do Max e pergunta algo ("venda ou
 * locação?"): aí a resposta curta da pessoa completa aquele pedido. Sem a
 * pergunta, um "gera uma proposta" de ontem reabriria a escrita num "oi" de
 * hoje (code review do #55).
 */
export function pedidoEmAberto(
  history: readonly { role: string; content: unknown }[]
): string | null {
  const ultima = history[history.length - 1];
  const anterior = history[history.length - 2];
  if (ultima?.role !== "assistant" || typeof ultima.content !== "string") return null;
  if (!ultima.content.includes("?")) return null;
  return anterior?.role === "user" && typeof anterior.content === "string" ? anterior.content : null;
}

/**
 * A escrita pode ser OFERECIDA a esta pessoa com esta política? (Sem o
 * prefiltro de texto — isso é do turn, não da pessoa.)
 *
 * UM predicado para dois consumidores: a oferta da tool (`ferramentasDoTurno`)
 * e a seção de criação do prompt (`modoDeCriacao`). Achado do review de
 * segurança do PR 2: o prompt dizia "use a ferramenta para propor a criação"
 * olhando só `podeEscrever`, enquanto a oferta já olhava a política — sem a
 * tool e com a instrução, o nano improvisava "pronto, criei". Dois predicados
 * divergem; um não.
 */
export function escritaPermitida(
  e: EntradaDeEscrita,
  identity: Candidate,
  policy: readonly Capability[]
): boolean {
  return podeEscrever(identity) && capabilitiesDeOferta(e).some((c) => policy.includes(c));
}

/**
 * O que o prompt diz sobre criar formulário/proposta — derivado do MESMO
 * predicado da oferta:
 *  - `disponivel`: a tool pode ser oferecida;
 *  - `sem_login`: corretor comissionado (sem `User`), nunca cria;
 *  - `sem_politica`: usuário da plataforma, mas a política deste turn não
 *    concede nenhuma criação (inclusive perfil fora do ar — fail-closed).
 */
export type ModoDeCriacao = "disponivel" | "sem_login" | "sem_politica";

export function modoDeCriacao(identity: Candidate, policy: readonly Capability[]): ModoDeCriacao {
  if (!podeEscrever(identity)) return "sem_login";
  return escritaPermitida(PROPOR_CRIACAO, identity, policy) ? "disponivel" : "sem_politica";
}

/**
 * Pedido EXPLÍCITO de criação a quem não pode criar agora: template, sem modelo.
 *
 * O prompt já diz a verdade nesses casos, mas um pedido direto ("cria uma
 * proposta pro Carlos") é exatamente onde o nano mais tende a encenar a ação.
 * Responder por template custa zero token e não depende de ele obedecer.
 * Pedido ambíguo (que só o prefiltro largo pega) continua no modelo, com a
 * seção do prompt correspondente.
 */
export function textoCriacaoIndisponivel(modo: Exclude<ModoDeCriacao, "disponivel">, falhaTransitoria: boolean): string {
  if (modo === "sem_login") {
    return (
      "Criar formulário ou proposta por aqui é só para quem tem login na " +
      "imobiliária. Fala com o gerente, que gera o link pelo sistema."
    );
  }
  if (falhaTransitoria) return TEXTO_INDISPONIVEL_AGORA;
  return (
    `Criar formulário ou proposta pelo ${nomeDoAgente()} não está disponível para você ` +
    "agora. Nada foi criado — dá pra criar pelo sistema."
  );
}

/**
 * Falha TRANSITÓRIA ao conferir a permissão (perfil ou chave de papel fora do
 * ar). Vale para os dois momentos — o "sim" de uma pendência e o primeiro
 * pedido de criação —, por isso "verificar" e não "confirmar". Texto próprio, distinto de "não está liberado": dizer a quem TEM a
 * permissão que ela não tem mandaria a pessoa ao administrador por causa de
 * uma oscilação de rede (achado D4 do review). A pendência cai mesmo assim —
 * o "sim" não pode valer depois sem nova pergunta.
 */
export const TEXTO_INDISPONIVEL_AGORA =
  "Não consegui verificar agora — nada foi criado. Tente de novo em instantes.";
