import { query } from "../db";
import { conversationKey } from "../phone";
import { PREFIXO_AVISO } from "./interativo";
import { acoesNumeradas } from "./render";
import type { Aviso } from "./schema";

/**
 * Resposta numérica ao aviso (M7): quem não tem botão (Newton; Meta com
 * `MAX_INTERACTIVE=off`) recebe o bloco "Responda: *1* · …" e responde "1".
 * Aqui o "1" vira o payload `av:` do mesmo roteador dos botões
 * (`aviso-botao.ts`); a decisão de TRATAR o número é do grafo, que só pergunta
 * quando o transporte não é interativo, o texto é só um dígito 1–3 e não há
 * fluxo aberto.
 *
 * ── Quando o número é do aviso ─────────────────────────────────────────────
 *
 * Um "2" solto é a resposta mais ambígua que existe. Só vale quando a ÚLTIMA
 * coisa que o Max mandou para esse telefone foi um aviso com ações, há menos
 * de 12h, e o Max não respondeu nada depois (nem outro aviso, nem um turno de
 * conversa). Qualquer dúvida, `null`: o "2" segue como mensagem normal.
 *
 * O número N é a N-ésima ação que o TEXTO ofereceu (`acoesNumeradas`, a mesma
 * lista que o `render` imprime), não a N-ésima de `aviso.acoes`: ações de link
 * não entram no bloco numerado.
 */

/** Passadas 12h o "2" já não é mais sobre aquele aviso. */
export const NUMERO_VALIDADE_MS = 12 * 60 * 60 * 1000;

const SO_UM_DIGITO = /^[1-3]$/;

export interface UltimoAviso {
  id: string;
  audience: string;
  sent_at: Date;
  aviso: Aviso | null;
  /**
   * A linha saiu dentro de um resumo de rajada (M8): o `provider_message_id`
   * começa com `resumo:` (marca gravada pelo despacho, que cobre transporte sem
   * `messageId`, envio incerto e órfã) ou outras linhas dividem o mesmo id. O resumo não tem bloco "Responda:", então o
   * "1" digitado depois dele não é resposta a aviso nenhum.
   */
  resumo?: boolean;
}

export interface DadosDoNumero {
  /** A última linha ENVIADA da outbox para o telefone (qualquer tipo), ou `null`. */
  ultimoEnviado(phone: string): Promise<UltimoAviso | null>;
  /** O Max respondeu algo (turno de conversa) a este telefone depois de `desde`? */
  houveRespostaDepois(phone: string, desde: Date): Promise<boolean>;
}

export const dadosDoNumero: DadosDoNumero = {
  async ultimoEnviado(phone) {
    const rows = await query<{ id: string; audience: string; sent_at: Date; aviso: Aviso | null; resumo: boolean }>(
      `SELECT o.id, o.audience, o.sent_at, o.aviso,
              (o.provider_message_id LIKE 'resumo:%'
               OR (o.provider_message_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM outbox x
                      WHERE x.provider_message_id = o.provider_message_id AND x.id <> o.id
                  ))) AS resumo
         FROM outbox o
        WHERE o.phone = $1 AND o.status = 'sent' AND o.sent_at IS NOT NULL
        ORDER BY o.sent_at DESC LIMIT 1`,
      [phone]
    );
    return rows[0] ?? null;
  },
  async houveRespostaDepois(phone, desde) {
    const rows = await query<{ um: number }>(
      `SELECT 1 AS um FROM conversation_turn
        WHERE phone = $1 AND created_at > $2 AND reply_text IS NOT NULL LIMIT 1`,
      [phone, desde]
    );
    return rows.length > 0;
  },
};

/**
 * `av:<linha>:<acao>` (ou `av:<linha>:item:<alvoId>` na lista) se o `texto` é a
 * resposta numérica a um aviso recente; senão `null` e a conversa segue normal.
 */
export async function payloadDoNumero(
  phone: string,
  texto: string,
  agora: Date,
  dados: DadosDoNumero = dadosDoNumero
): Promise<string | null> {
  const digito = texto.trim();
  if (!SO_UM_DIGITO.test(digito)) return null;

  const fone = conversationKey(phone);
  const ultimo = await dados.ultimoEnviado(fone);
  if (!ultimo || !ultimo.aviso || ultimo.audience === "deal_party") return null;
  if (ultimo.resumo) return null;

  const enviadoEm = new Date(ultimo.sent_at);
  if (!(agora.getTime() - enviadoEm.getTime() <= NUMERO_VALIDADE_MS)) return null;

  const escolhida = acoesNumeradas(ultimo.aviso)[Number(digito) - 1];
  if (!escolhida) return null;

  if (await dados.houveRespostaDepois(fone, enviadoEm)) return null;

  // Na lista cada linha é uma ação com o seu alvo: o id da ação se repete, o alvoId não.
  if (ultimo.aviso.forma === "lista" && escolhida.alvoId) {
    return `${PREFIXO_AVISO}${ultimo.id}:item:${escolhida.alvoId}`;
  }
  return `${PREFIXO_AVISO}${ultimo.id}:${escolhida.id}`;
}
