/**
 * Intenção de formulário, tolerante a erro de digitação (T3).
 *
 * O corretor escreve rápido no WhatsApp: "propsta", "porposta", "proposa",
 * "captaçao", "capitação". O regex do v1 só entende a grafia certa. Aqui o
 * texto é normalizado (minúsculas, sem acento) e as palavras-chave de 7+ letras
 * (proposta, captacao, formulario, no singular e no plural) são aproximadas por
 * distância de edição <= 1 (inserção, remoção, troca e transposição).
 *
 * Só 7+ letras, de propósito: palavra curta com 1 letra de diferença é outra
 * palavra com frequência. E há uma lista de palavras REAIS que ficam como
 * estão ("proposto", "contato"): sem ela, "foi proposto um valor" viraria
 * "foi proposta um valor" e "contato" viraria "contrato".
 *
 * F5: proposta e captação aceitam até 2 edições ("porposa", "capitaao"), desde que a
 * palavra comece pela mesma letra (a troca da inicial é quase sempre outra palavra:
 * "resposta", "aposta", "capacitação", "adaptação"). A palavra-chave SOZINHA ("propsta",
 * "uma captaçao") também é pedido de criação.
 *
 * Quem decide se isto vale é o chamador, pela feature `formularios_v2`
 * (`toleranteNaOrg`): sem ela o v1 segue com o regex de hoje, byte a byte.
 *
 * Puro: sem rede, sem estado, sem PII (o texto do corretor não é guardado aqui).
 */

import { featureEnabled } from "@/lib/runtime/rollout";

export type IntencaoDeFormulario =
  | { tipo: "criar"; alvo: "proposta" | "captacao"; esteira?: "venda" | "locacao" }
  | { tipo: "corrigir_dado" | "corrigir_redacao"; alvo: "proposta" | "captacao" | "contrato_do_negocio" }
  | null;

/**
 * O v2 tolera erro de digitação; o v1 (feature desligada ou outra org) fica com o regex de hoje.
 *
 * Só vale com a feature ligada E o servidor dizendo que fala v2 (`options.fluxoV2 === true`,
 * §18.13.3): com a feature ligada e o servidor no v1 a tolerância misturaria os dois
 * mundos. `options` ainda não consultado (ou sem resposta) = sem tolerância. Os
 * chamadores de hoje não consultam o `options` neste ponto e por isso chamam só com a
 * org (v1 byte a byte); o condutor v2 (PR-C) passa `{ fluxoV2 }` do `options` que consultou.
 */
export function toleranteNaOrg(orgId: string | undefined, options?: { fluxoV2?: boolean | null }): boolean {
  return options?.fluxoV2 === true && featureEnabled("formularios_v2", orgId);
}

/**
 * Pedido de criação de documento. Movidos de `tools.ts` SEM mudança de texto
 * (a v1 continua com exatamente estes regex; a nota longa sobre o porquê da
 * âncora no objeto segue em `tools.ts`).
 */
export const PEDE_CRIACAO =
  /\b(?:(?:cri[ae]r?|crie|mont[ae]r?|abr[ae]|abrir|fa[zc]a?|fazer|ger[ae]r?|manda?r?|envi[ae]r?)|(?:preciso|precisava|quero|queria|gostaria)(?:\s+de)?(?:\s+(?:criar|fazer|montar|abrir|gerar|mandar|enviar))?)\s+(?:(?:uma|um)\s+)?(?:(?:nova|novo)\s+)?(?:rascunho\s+de\s+)?(?:proposta|formulario|ficha|cadastro)\b/i;

export const PEDE_CRIACAO_SEM_VERBO =
  /^(?:(?:uma|um)\s+)?(?:(?:nova|novo)\s+(?:proposta|formulario|ficha|cadastro)|(?:proposta|formulario|ficha|cadastro)\s+(?:nova|novo))\b/i;

const PALAVRAS_CHAVE = ["proposta", "propostas", "captacao", "captacoes", "formulario", "formularios"] as const;

/** Palavras reais a 1 edição de uma palavra-chave: nunca corrigir. */
const PROTEGIDAS = new Set([
  "proposto", "propostos", "proposito", "propositos", "proposital", "propositado",
  "captador", "captadora", "captadores",
  // F5: reais a 1-2 edições (preposta = representante; posposta = adiada).
  "preposta", "prepostas", "preposto", "prepostos", "posposta", "pospostas", "pospostos",
  "capacitacao", "capacitacoes", "adaptacao", "adaptacoes", "formulacao", "formulacoes",
]);

/** Palavras que aceitam 2 edições (mesma inicial); as demais, só 1. */
const ACEITAM_DUAS_EDICOES = new Set(["proposta", "propostas", "captacao", "captacoes"]);

const MINIMO_DE_LETRAS = 7;

/** Distância de Damerau-Levenshtein restrita (transposição de vizinhas conta 1). */
function distancia(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const linha = new Array<number>(b.length + 1).fill(0);
    linha[0] = i;
    return linha;
  });
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

function corrigirPalavra(palavra: string): string {
  if (palavra.length < MINIMO_DE_LETRAS || PROTEGIDAS.has(palavra)) return palavra;
  if ((PALAVRAS_CHAVE as readonly string[]).includes(palavra)) return palavra;
  for (const chave of PALAVRAS_CHAVE) {
    if (Math.abs(chave.length - palavra.length) <= 1 && distancia(palavra, chave) <= 1) return chave;
  }
  for (const chave of PALAVRAS_CHAVE) {
    if (!ACEITAM_DUAS_EDICOES.has(chave) || palavra[0] !== chave[0]) continue;
    if (Math.abs(chave.length - palavra.length) <= 2 && distancia(palavra, chave) <= 2) return chave;
  }
  return palavra;
}

/** Minúsculas, sem acento, espaços colapsados; palavras-chave com 1 erro corrigidas. Idempotente. */
export function normalizarParaIntencao(texto: string): string {
  const base = texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
  return base.replace(/[a-z]{7,}/g, corrigirPalavra);
}

const VERBO_DE_CORRECAO_G =
  /\b(?:corrig\w*|corrij\w*|ajust\w*|retific\w*|arrum\w*|conserta\w*|troc\w*|muda\w*|alter\w*|edit\w*|errei|errado|errada)\b/g;
const PARTICIPIO_DE_CORRECAO = /^(?:corrigid|ajustad|retificad|arrumad|consertad|trocad|mudad|alterad|editad)[oa]s?$/;
const NEGACAO_ANTES_DO_VERBO = /\b(?:nao|nunca|jamais|sem)\s+(?:\w+\s+){0,2}$/;
const INTERROGATIVA_ANTES_DO_VERBO = /\b(?:como|por que|porque|pq|quando|onde|qual|quais|quem|o que|sera que)\s+(?:\w+\s+){0,3}$/;
const PEDIDO_EDUCADO_ANTES_DO_VERBO = /\b(?:pode|podes|poderia|consegue|conseguiria|da pra|d[aá] pra|vc pode|voce pode)\s+(?:\w+\s+){0,2}$/;

/**
 * `true` quando o texto PEDE uma correção (P4). O verbo sozinho casava pergunta
 * ("a proposta corrige?"), negação ("não corrige a proposta") e particípio
 * ("foi corrigida ontem"); nenhum destes é pedido. Pedido educado com "?"
 * ("pode corrigir a proposta?") continua sendo pedido. `n` já vem normalizado.
 */
function pedeCorrecao(n: string): boolean {
  const pergunta = n.trimEnd().endsWith("?");
  for (const m of n.matchAll(VERBO_DE_CORRECAO_G)) {
    if (PARTICIPIO_DE_CORRECAO.test(m[0])) continue;
    const idx = m.index ?? 0;
    // Só a oração do verbo conta: pontuação separa ("não, corrige a proposta").
    const prefixo = n.slice(0, idx).split(/[.,;!?]/).pop() ?? "";
    if (NEGACAO_ANTES_DO_VERBO.test(prefixo)) continue;
    if (INTERROGATIVA_ANTES_DO_VERBO.test(prefixo)) continue;
    if (n.slice(idx + m[0].length).trimStart().startsWith("?")) continue;
    if (pergunta && !PEDIDO_EDUCADO_ANTES_DO_VERBO.test(prefixo)) continue;
    return true;
  }
  return false;
}
const PALAVRA_CHAVE_SOZINHA = /^(?:(?:uma|um|a|o)\s+)?(?:(?:nova|novo)\s+)?(proposta|captacao|formulario)\s*[.!]*$/;
const MENCAO_DE_TEXTO = /\b(?:texto|redacao|clausulas?|paragrafos?|trecho)\b/;

function esteiraDoTexto(n: string): "venda" | "locacao" | undefined {
  const locacao = /\b(?:locacao|alugu\w+|alugar|inquilin\w+|locatari\w+)\b/.test(n);
  const venda = /\b(?:venda|vender|compra|comprar|comprador\w*|vendedor\w*)\b/.test(n);
  if (locacao === venda) return undefined;
  return locacao ? "locacao" : "venda";
}

/**
 * O que o corretor quer de um formulário: criar uma proposta/captação ou corrigir
 * algo. `null` quando o texto é outra coisa. "Corrige o contrato" (do negócio) é
 * só a INTENÇÃO `corrigir_redacao` sobre `contrato_do_negocio`: o que o Max
 * responde (o link do Doc) é de outra tarefa (T17).
 *
 * Único chamador em produção no PR-C1: `abrirV2` (condutor), que lê só a CORREÇÃO na
 * abertura do v2 e responde `formulario_correcao` em vez de abrir proposta nova. O
 * roteamento completo da correção entra no PR-C; não ligar `formularios_v2` esperando
 * que o Max já corrija. Aqui a normalização é sempre tolerante: quem decide se a
 * tolerância vale para a org é o chamador (`toleranteNaOrg`).
 */
export function lerIntencaoDeFormulario(texto: string): IntencaoDeFormulario {
  const n = normalizarParaIntencao(texto);
  if (!n) return null;

  // F5: só a palavra-chave ("propsta", "uma captaçao", "nova proposta!"): pedido de criação. No singular e sem
  // mais nada na frase: "propostas" é consulta, "a proposta do João" e "proposta de novo?" são outra coisa.
  const sozinha = PALAVRA_CHAVE_SOZINHA.exec(n);
  if (sozinha) return { tipo: "criar", alvo: /^captac/.test(sozinha[1]!) ? "captacao" : "proposta" };

  const temCaptacao = /\bcaptac(?:ao|oes)\b/.test(n);
  // "cria uma captação" é criação como "cria uma proposta": o mesmo regex, com a palavra trocada.
  const comoProposta = n.replace(/\bcaptac(?:ao|oes)\b/g, "proposta");
  if (PEDE_CRIACAO.test(comoProposta) || PEDE_CRIACAO_SEM_VERBO.test(comoProposta)) {
    const esteira = temCaptacao ? undefined : esteiraDoTexto(n);
    return { tipo: "criar", alvo: temCaptacao ? "captacao" : "proposta", ...(esteira ? { esteira } : {}) };
  }

  if (pedeCorrecao(n)) {
    const redacao = MENCAO_DE_TEXTO.test(n);
    if (temCaptacao) return { tipo: redacao ? "corrigir_redacao" : "corrigir_dado", alvo: "captacao" };
    if (/\bpropostas?\b/.test(n)) return { tipo: redacao ? "corrigir_redacao" : "corrigir_dado", alvo: "proposta" };
    if (/\bcontratos?\b/.test(n)) return { tipo: "corrigir_redacao", alvo: "contrato_do_negocio" };
  }
  return null;
}
