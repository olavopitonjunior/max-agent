/**
 * PR-E (T17, rodada 1): o detector lexical do pedido de CORREÇÃO DE TEXTO, sem dependência de fluxo.
 * Vive à parte para que o fluxo de correção (correcao-texto.ts) e o roteamento (correcao-roteamento.ts)
 * usem a MESMA regra sem import circular.
 *
 * "Muda a cláusula de multa da proposta" é texto do documento; "corrige o CPF da proposta" é dado da
 * proposta (gestão). A diferença é lexical e sem modelo: só vale com uma palavra de TEXTO junto de um
 * verbo de edição. "item"/"itens" e "texto" sozinho NÃO são marca: "inclui o item churrasqueira" e
 * "atualiza o texto do anúncio" são dado (R32).
 */
import { normalizar } from "../tools";

export type AlvoPedido = "proposta" | "captacao" | "contrato" | "indefinido";

const VERBO_DE_EDICAO = /\b(?:mud|alter|troc|corrig|corrij|ajust|edit|reescrev|reescrit|reformul|redij|retific|revis|atualiz|substitu|coloc|coloq|tir|remov|acrescent|adicion|inclu|aument|diminu|reduz)\w*/;
/** Palavra FORTE: só ela basta com um fluxo aberto (a pessoa está no meio de outra coisa). */
const MARCA_FORTE = /\b(?:clausulas?|paragrafos?|redacao|textos? d[aeo]s? (?:documento|proposta|captacao|contrato))\b/;
/** Palavra de texto fora de fluxo: a forte mais "trecho". */
const MARCA_DE_TEXTO = /\b(?:clausulas?|paragrafos?|redacao|trechos?|textos? d[aeo]s? (?:documento|proposta|captacao|contrato))\b/;
const NEGACAO = /\b(?:nao|nunca|jamais)\b/;
const PERGUNTA_DE_PROCESSO = /^(?:como|quando|onde|por que|porque|o que|qual|quais|quanto|posso|da pra|da para|e possivel)\b/;

export interface OpcoesDoDetector {
  /** Com um fluxo aberto: só palavra forte conta. */
  forte?: boolean;
}

/** O pedido é corrigir o TEXTO de um documento? `null` = não é (dado, pergunta, negação ou outro assunto). */
export function pedeCorrecaoDeTexto(texto: string, opts: OpcoesDoDetector = {}): AlvoPedido | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (!t || NEGACAO.test(t) || PERGUNTA_DE_PROCESSO.test(t)) return null;
  // "Pode mudar a cláusula…?" é pedido; outra frase com "?" é pergunta.
  if (/\?\s*$/.test(texto) && !/^(?:pode|consegue)\b/.test(t)) return null;
  if (!VERBO_DE_EDICAO.test(t)) return null;
  const proposta = /\bproposta\b|\bprop-\d/.test(t);
  const marca = opts.forte ? MARCA_FORTE : MARCA_DE_TEXTO;
  // "Corrige o contrato" (sem palavra de texto): contrato não é desta versão; responde com o caminho da tela.
  if (!marca.test(t)) return !proposta && /\bcontrato\b/.test(t) && !/\bcaptacao\b/.test(t) ? "contrato" : null;
  if (proposta) return "proposta";
  if (/\bcaptacao\b|\bcaptacoes\b/.test(t)) return "captacao";
  if (/\bcontrato\b/.test(t)) return "contrato";
  return "indefinido";
}
