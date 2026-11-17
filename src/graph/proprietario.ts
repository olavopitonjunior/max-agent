import { normalizar } from "./tools";
import type { ChatMessage } from "./graph";
import { PERGUNTA_ENVIAR_OU_ENCERRAR } from "@/lib/aviso/decisao-proposta";

/**
 * "Enviar ao proprietário" e "encerrar" depois que o proponente assinou
 * (plano de 14/11/2026; servidor: docs/max.md §18.7 do contractmaker, verbos
 * `proposal.send_owner` e `proposal.complete`).
 *
 * Só DETECÇÃO, pura e sem rede: o fluxo (resumo, SIM, chamada ao servidor,
 * tradução das recusas) é o de `assinatura.ts`, o mesmo de lembrar/cancelar.
 *
 * Princípios:
 *  - nada aqui escolhe sozinho: "encerrar" sem pedido explícito e sem um aviso
 *    pendente NÃO vira verbo (encerrar é irreversível); "sim" e "manda" soltos
 *    também não são resposta ao aviso;
 *  - a sugestão pendente é lida do que o próprio Max já disse no thread (o aviso
 *    `awaiting_decision` é semeado como mensagem do assistente), sem consulta;
 *  - quem decide se pode é o servidor; o Max só traduz.
 */

export type OperacaoDoProprietario = "enviar_proprietario" | "encerrar";

/** O aviso que o Max mandou: a proposta cuja decisão está pendente. */
export interface SugestaoPendente {
  codigo: string;
}

const PREF = String.raw`^(?:(?:pode|poderia|consegue|quero|preciso|por favor|favor|pf|pfv)[\s,]+)*(?:que\s+(?:voce\s+|vc\s+)?)?`;
const DONO = String.raw`(?:proprietari\w*|vendedor\w*|locador\w*|dono\w*)`;
/** "a proposta", "PROP-2026-12": o alvo é uma proposta, nunca um contrato. */
const REFERENCIA = /\b(?:proposta\b|prop-\d)/;
const DESTINO = new RegExp(String.raw`\b(?:ao|a|para|pro|pra)\s+(?:o\s+|a\s+)?${DONO}`);
const SEM_O_DONO = new RegExp(String.raw`\bsem\s+(?:o\s+|a\s+)?${DONO}`);
const VERBO_ENVIAR = new RegExp(PREF + String.raw`(?:envi|mand|encaminh)(?:a|ar|e|o)\b`);
const VERBO_ENCERRAR = new RegExp(PREF + String.raw`encerr(?:a|ar|e)\b`);
/** "manda um lembrete ao vendedor" é lembrete (assinatura.ts), não envio da via. */
const LEMBRETE = /\blembrete/;
/** Negar a AÇÃO ("não envia", "nunca encerra"), e não qualquer "não" da frase. */
const NEGA = /\b(?:nao|nunca|jamais)\s+(?:precisa\s+|quero\s+que\s+(?:voce\s+|vc\s+)?|vai\s+|pode\s+|deve\s+)?(?:envi|mand|encaminh|encerr)/;

/**
 * O pedido é, por extenso, enviar a proposta ao proprietário ou encerrá-la sem
 * ele, com a proposta citada? Pergunta ("?" fora de "pode…?") e negação não contam.
 */
export function pedeProprietario(texto: string): OperacaoDoProprietario | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "").trim();
  if (!t || NEGA.test(t)) return null;
  // "Pode enviar…?" é pedido; qualquer outra frase com "?" é pergunta.
  if (/\?\s*$/.test(texto.trim()) && !/^(pode|poderia|consegue)\b/.test(t)) return null;
  if (!REFERENCIA.test(t)) return null;
  if (VERBO_ENCERRAR.test(t) && SEM_O_DONO.test(t)) return "encerrar";
  if (VERBO_ENVIAR.test(t) && DESTINO.test(t) && !LEMBRETE.test(t)) return "enviar_proprietario";
  return null;
}

const CODIGO = /\bPROP-\d{4}-\d+\b/i;
/** "Proposta PROP-2026-0031: Responda ENVIAR para mandar ao proprietário ou ENCERRAR…" (a frase fixa do aviso). */
const CODIGO_DA_PERGUNTA = new RegExp(String.raw`\bproposta\s+(PROP-\d{4}-\d+):\s*` + escaparRegex(PERGUNTA_ENVIAR_OU_ENCERRAR), "i");

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

/**
 * Há um aviso de "o proponente assinou" esperando decisão? Só a ÚLTIMA mensagem
 * do assistente conta: se a conversa andou depois do aviso, "encerrar" solto
 * voltou a ser só uma palavra. Reconhece o texto do template do WhatsApp
 * (`max_proposta_assinada_proponente`, o mesmo do `awaiting_decision`) e a
 * versão com as duas opções por extenso.
 */
export function sugestaoPendente(messages: readonly ChatMessage[] | undefined): SugestaoPendente | null {
  const ultima = [...(messages ?? [])].reverse().find((m) => m.role === "assistant");
  if (!ultima || typeof ultima.content !== "string") return null;
  // A pergunta fixa do aviso (`lib/aviso/decisao-proposta.ts`) traz o código na própria frase:
  // com mais de um código na mensagem, vale o dela.
  const daPergunta = CODIGO_DA_PERGUNTA.exec(ultima.content)?.[1];
  const codigo = daPergunta ?? CODIGO.exec(ultima.content)?.[0];
  if (!codigo) return null;
  if (daPergunta) return { codigo: codigo.toUpperCase() };
  const t = normalizar(ultima.content);
  const duasOpcoes = /\bencerr/.test(t) && new RegExp(String.raw`\benvi\w*\s+(?:ao|a|para|pro|pra)\s+(?:o\s+|a\s+)?${DONO}`).test(t);
  const proponenteAssinou = /\bproponente assinou\b/.test(t);
  return duasOpcoes || proponenteAssinou ? { codigo: codigo.toUpperCase() } : null;
}

const DE_NOVO = String.raw`(?:(?:pode|por favor|pf|pfv)\s+)*`;
const FIM = String.raw`[.!\s]*$`;
/** "enviar", "envia ao proprietário", "encaminha pro vendedor"; "manda" só com o destino. */
const RESPOSTA_ENVIAR = new RegExp(
  `^${DE_NOVO}(?:(?:envi|encaminh)(?:ar|a|e)(?:\\s+(?:(?:ao|a|para|pro|pra)\\s+(?:o\\s+|a\\s+)?${DONO}|ele|ela))?|mand(?:ar|a|e)\\s+(?:ao|a|para|pro|pra)\\s+(?:o\\s+|a\\s+)?${DONO})(?:\\s+(?:agora|mesmo))?${FIM}`
);
/** "encerrar", "encerra aqui", "encerra sem o proprietário". */
const RESPOSTA_ENCERRAR = new RegExp(
  `^${DE_NOVO}encerr(?:ar|a|e)(?:\\s+(?:aqui|agora|mesmo|por aqui|a proposta|essa proposta|essa|ela|sem\\s+(?:o\\s+|a\\s+)?${DONO}))*${FIM}`
);

/**
 * Resposta curta ao aviso pendente. "sim", "ok" e "manda" soltos NÃO valem: o
 * aviso tem duas saídas e a pessoa precisa dizer qual.
 */
export function respostaAoAviso(texto: string, sugestao: SugestaoPendente | null): OperacaoDoProprietario | null {
  if (!sugestao) return null;
  const t = normalizar(texto.replace(/[*_]/g, ""))
    .replace(/^max\b[\s,:-]*/, "")
    .trim();
  if (!t || /\?\s*$/.test(texto.trim()) || NEGA.test(t)) return null;
  if (RESPOSTA_ENCERRAR.test(t)) return "encerrar";
  if (RESPOSTA_ENVIAR.test(t)) return "enviar_proprietario";
  return null;
}
