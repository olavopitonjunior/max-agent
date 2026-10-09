import type { Capability } from "./policy";
import { normalizar } from "./tools";

/**
 * O que o Max faz — dito pelo SISTEMA, a partir da política deste turn, e não
 * pelo modelo (decisão do Olavo, 09/10/2026).
 *
 * Prod 09/10: "O que vc pode fazer agora?" → o nano respondeu "coleta de dados
 * pendentes e emissão das etapas de certidões e cobrança de comissão" — duas
 * coisas que o Max não faz, tiradas do texto-base do prompt. Capacidade
 * prometida é capacidade cobrada: a lista sai do que a política concede.
 */

/**
 * Ancorado na frase inteira e com o "você" explícito (review 09/10): "o que
 * pode atrasar a assinatura?" e "o que fazer agora?" são perguntas do
 * processo, não sobre o Max.
 */
const PEDE_CAPACIDADES = new RegExp(
  String.raw`^(?:e\s+)?(?:(?:o\s*que|oq|q)\s+(?:mais\s+)?(?:que\s+)?(?:vc|voce|tu|o max)\s+(?:pode|sabe|consegue|faz)(?:\s+fazer)?(?:\s+(?:agora|por mim|aqui|pra mim|por aqui))?` +
    String.raw`|como\s+(?:vc|voce)\s+(?:pode\s+)?(?:me\s+)?ajudar|quais\s+(?:sao\s+)?(?:as\s+)?suas\s+funcoes)\s*[?.!]*$`
);

/** "O que você pode fazer?", "o que vc faz?", "como você pode me ajudar?". */
export function pedeCapacidades(texto: string): boolean {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "");
  return PEDE_CAPACIDADES.test(t.trim());
}

export function textoDeCapacidades(policy: readonly Capability[], podeEscrever: boolean): string {
  const tem = (c: Capability) => policy.includes(c);
  const linhas: string[] = [];
  const proposta: string[] = [];
  if (podeEscrever && tem("proposal.create")) proposta.push("criar e ajustar");
  if (podeEscrever && tem("proposal.send")) proposta.push("enviar para assinatura");
  if (tem("proposal.list")) proposta.push("achar pelo nome do cliente ou código e ver o status");
  if (podeEscrever && tem("proposal.create")) proposta.push("duplicar");
  if (podeEscrever && tem("proposal.delete")) proposta.push("excluir");
  if (proposta.length) linhas.push(`- Propostas: ${proposta.join(", ")}.`);
  if (podeEscrever && tem("proposal.create")) linhas.push("- Converter proposta assinada em negócio, com o link do formulário.");
  const negocio: string[] = [];
  if (podeEscrever && tem("form.create")) negocio.push("criar o formulário");
  if (tem("deal.list") || tem("deal.pending")) negocio.push("consultar negócios e pendências");
  if (negocio.length) linhas.push(`- Negócios: ${negocio.join(", ")}.`);
  if (!linhas.length) return "Por aqui eu tiro dúvidas sobre o processo da imobiliária. Para o resto, fale com a imobiliária.";
  linhas.push("Contrato e cobrança são pela tela do negócio no sistema.");
  return `Pelo WhatsApp eu consigo:\n${linhas.join("\n")}`;
}

/**
 * O verbo age DIRETO sobre o contrato ("manda o contrato", "gera o contrato do
 * João") — review 09/10: verbo solto casava "converte a proposta… pra gerar o
 * contrato" (conversão, que o Max faz), "faz uma proposta, contrato de 30
 * meses" e "o contrato já foi enviado?".
 */
const ACAO_NO_CONTRATO =
  /\b(?:ger[ae]r?|emit[ae]r?|emiti|edit[ae]r?|alter[ae]r?|corrij[ae]|corrigir|aprov[ae]r?|envi[ae]r?|mand[ae]r?|dispar[ae]r?|faz(?:er)?|fa[cç]a|cri[ae]r?|assin[ae]r?)\s+(?:o\s+|um\s+|esse\s+|este\s+|meu\s+)?contrato\b|\bcontrato\s+(?:pra|para)\s+(?:assinatura|assinar)\b/;
const COBRANCA = /\bcobrancas?\b|\b(?:ger[ae]r?|emit[ae]r?|mand[ae]r?|envi[ae]r?|cri[ae]r?)\s+(?:o\s+|um\s+|a\s+|uma\s+)?(?:boleto|cobranca)\b/;
const PERGUNTA = /^(como|quando|onde|por que|porque|o que|qual|quais|quanto)\b/;
const NEGACAO = /\b(nao|nunca|jamais)\b/;

/**
 * Pedido de fazer algo com o CONTRATO (gerar, editar, enviar, aprovar) ou de
 * cobrança. O Max não faz nenhum dos dois (decisão do Olavo, 09/10): responde
 * com o caminho, nunca deixa o modelo improvisar. Pergunta (inclusive com "?"
 * no fim) e negação seguem para o atendimento normal. Quem chama avalia antes
 * continuidade e gestão: "converte… pra gerar o contrato" é conversão.
 */
export function pedeAcaoForaDoMax(texto: string): "contrato" | "cobranca" | null {
  const t = normalizar(texto).replace(/^max\b[\s,:-]*/, "");
  if (PERGUNTA.test(t) || /\?\s*$/.test(texto) || NEGACAO.test(t)) return null;
  if (COBRANCA.test(t)) return "cobranca";
  if (ACAO_NO_CONTRATO.test(t)) return "contrato";
  return null;
}

/** `linkDoNegocio`: o negócio de que a conversa acabou de tratar, quando há. */
export function textoForaDoMax(tipo: "contrato" | "cobranca", linkDoNegocio?: string | null): string {
  const tela = linkDoNegocio ? `Abra o negócio: ${linkDoNegocio}` : "Abra o negócio pela tela de Negócios do sistema.";
  if (tipo === "cobranca") return `Cobrança não é feita pelo Max. Se você tiver permissão, siga pelo sistema. ${tela}`;
  return "Contrato eu não gero, não edito nem envio para assinatura. Se você tiver permissão de contrato, siga pela tela do negócio. " +
    `${tela}\nQuando o contrato for assinado por todos, eu te aviso por aqui (se o aviso estiver ligado na sua imobiliária).`;
}
