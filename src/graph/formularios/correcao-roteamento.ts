/**
 * PR-E (T17): o roteamento determinístico do pedido de CORREÇÃO DE TEXTO (R30).
 *
 * "Muda a cláusula de multa da proposta" é texto do documento (`text.suggest`); "corrige o CPF da proposta" é
 * dado da proposta e segue em `proposal.update` (gestão, inalterada). A diferença é lexical e sem modelo:
 * só vale com uma palavra de TEXTO (cláusula, parágrafo, redação, trecho, texto) junto de um verbo de edição.
 *
 * Alvo:
 *  - proposta: o código/termo citado (busca), senão a proposta do fluxo aberto, senão pergunta qual;
 *  - captação: SÓ com o `captacaoId` do fluxo de captação aberto; nunca adivinha, pergunta qual;
 *  - contrato: não é desta versão; responde com o caminho da tela, não com recusa genérica.
 *
 * Nada aqui roda sem a feature `formularios_v2` E a capability `document.text.edit` (o chamador confere).
 */
import type { ContextoDoTurno, DepsDoFluxo, Fluxo, PassoDoFluxo } from "../fluxos";
import { buscarPropostas, codigoCitado, rotuloDaProposta } from "../localizar";
import { termoDaEdicao } from "../gestao";
import { iniciarCorrecaoTexto } from "./correcao-texto";
import type { AlvoPedido } from "./correcao-detector";

// O detector vive em correcao-detector.ts (sem import circular com o fluxo); reexportado para quem já o importa daqui.
export { pedeCorrecaoDeTexto } from "./correcao-detector";
export type { AlvoPedido } from "./correcao-detector";

/** Com um fluxo aberto: a pessoa está no meio de outra coisa. A correção NUNCA o substitui (R32). */
export const TEXTO_FLUXO_ABERTO =
  "Estamos no meio de outro pedido, então não abri a correção do texto. Termine o que estamos fazendo, ou diga *cancelar* para parar, " +
  "e depois peça a correção do texto de novo. Não mexi em nada.";

export const TEXTO_CONTRATO_PELA_TELA = (link?: string | null): string =>
  "O texto do contrato eu não corrijo por aqui: ele é ajustado no editor do documento, pela tela do negócio" +
  `${link ? `: ${link}` : ", no sistema."}\n` +
  "Por aqui eu corrijo o texto da proposta e da captação, quando o recurso está liberado para você.";

export const TEXTO_QUAL_PROPOSTA =
  "Qual proposta devo corrigir? Me diga o código (por exemplo PROP-2026-0001), o nome do cliente ou o endereço, e repita o que mudar.";

export const TEXTO_QUAL_CAPTACAO =
  "Qual captação devo corrigir? Eu só corrijo o texto de uma captação quando ela está aberta aqui na conversa, para não errar de documento. " +
  "Abra a captação (diga “captação”) ou faça a correção pela tela de captações.";

export const TEXTO_QUAL_DOCUMENTO =
  "Qual documento devo corrigir: a proposta (me diga o código ou o nome do cliente) ou a captação aberta aqui? Repita o pedido citando um deles.";

export interface EntradaDoRoteamento {
  alvo: AlvoPedido;
  texto: string;
  /** O fluxo aberto (já rebaixado se vencido), a única fonte de contexto para o alvo. */
  atual: Fluxo | null | undefined;
  /** Link do negócio quando a conversa acabou de tratar de um (resposta de contrato). */
  linkDoNegocio?: string | null;
}

type Alvo = { alvo: "proposal" | "captacao"; id: string; rotulo?: string };

/** A proposta/captação do fluxo aberto, quando há. Nunca de memória nem de "a mais recente". */
function doContexto(atual: Fluxo | null | undefined): { proposta?: Alvo; captacao?: Alvo } {
  if (!atual) return {};
  if (atual.kind === "proposta_v2" && atual.proposalId) return { proposta: { alvo: "proposal", id: atual.proposalId } };
  if (atual.kind === "proposta" && atual.propostaId) {
    return { proposta: { alvo: "proposal", id: atual.propostaId, rotulo: atual.codigo ?? atual.rotulo } };
  }
  if (atual.kind === "captacao" && atual.captacaoId && !atual.chave) {
    return { captacao: { alvo: "captacao", id: atual.captacaoId, rotulo: atual.codigo } };
  }
  return {};
}

const sem = (reply: string, evento: string): PassoDoFluxo => ({ reply, fluxo: null, evento });

/**
 * Decide e abre. `null` = o turno não é do fluxo de correção (o servidor desligou o recurso): o grafo segue
 * como se a detecção não tivesse disparado. Devolve `fluxo: null` em respostas que só orientam (o fluxo aberto,
 * se houver, é rebaixado por quem chama).
 */
export async function rotearCorrecaoDeTexto(
  e: EntradaDoRoteamento, ctx: ContextoDoTurno, deps: DepsDoFluxo
): Promise<{ passo: PassoDoFluxo; orienta: boolean } | null> {
  if (e.alvo === "contrato") {
    return { passo: sem(TEXTO_CONTRATO_PELA_TELA(e.linkDoNegocio), "correcao_texto_contrato"), orienta: true };
  }
  const ctxo = doContexto(e.atual);
  let alvo: Alvo | null = null;

  if (e.alvo === "captacao") {
    if (!ctxo.captacao) return { passo: sem(TEXTO_QUAL_CAPTACAO, "correcao_texto_qual_captacao"), orienta: true };
    alvo = ctxo.captacao;
  } else {
    // Proposta (ou indefinido). Citação explícita (código/nome) vence o contexto.
    const citou = codigoCitado(e.texto) || termoDaEdicao(e.texto);
    if (e.alvo === "proposta" && citou) {
      const r = await buscarPropostas(deps, e.texto, termoDaEdicao(e.texto));
      if (!r) return { passo: sem("Não consegui consultar suas propostas agora. Nada foi alterado; tente de novo em instantes.", "correcao_texto_sem_resposta"), orienta: true };
      if (r.itens.length === 1 && r.total <= 1) {
        const p = r.itens[0]!;
        alvo = { alvo: "proposal", id: p.id, rotulo: rotuloDaProposta({ codigo: p.codigo, titulo: p.titulo }) };
      } else if (!r.itens.length) {
        return { passo: sem(`Não achei proposta sua com "${r.termo ?? "esse termo"}". ${TEXTO_QUAL_PROPOSTA}`, "correcao_texto_proposta_nao_achada"), orienta: true };
      } else {
        const lista = r.itens.slice(0, 5).map((p, i) => `${i + 1}. ${rotuloDaProposta(p)}`).join("\n");
        return { passo: sem(`Achei mais de uma proposta${r.termo ? ` com "${r.termo}"` : ""}:\n${lista}\nMe diga o código da que devo corrigir e repita o pedido.`, "correcao_texto_varias_propostas"), orienta: true };
      }
    } else if (ctxo.proposta) {
      alvo = ctxo.proposta;
    } else if (e.alvo === "indefinido" && ctxo.captacao) {
      alvo = ctxo.captacao;
    } else {
      return { passo: sem(e.alvo === "proposta" ? TEXTO_QUAL_PROPOSTA : TEXTO_QUAL_DOCUMENTO, "correcao_texto_qual_documento"), orienta: true };
    }
  }

  const passo = await iniciarCorrecaoTexto(ctx, deps, { alvo: alvo.alvo, id: alvo.id, rotulo: alvo.rotulo, pedido: e.texto });
  if (passo.liberar) return null;
  return { passo, orienta: false };
}
