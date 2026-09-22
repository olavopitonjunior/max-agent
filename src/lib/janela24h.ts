/**
 * Janela de atendimento de 24h da Cloud API da Meta.
 *
 * Texto livre só sai até 24h depois da ÚLTIMA mensagem da pessoa; fora disso,
 * só template aprovado. A Meta costuma aceitar o envio fora da janela com 200
 * e recusar depois, no webhook (`failed`, erro 131047) — então o outbox
 * pergunta aqui ANTES de enviar, em vez de descobrir tarde demais.
 *
 * Não confundir com `window.ts`, que é o horário comercial (7h–22h) de envio
 * de notificação: uma regra nossa, não da Meta.
 */

import { query } from "./db";
import type { InboundMessage } from "./transport";

/**
 * Marca a janela como aberta para quem acabou de escrever. Instante da
 * MENSAGEM no provedor, não o da chegada; GREATEST para uma reentrega
 * atrasada não recuar o relógio.
 *
 * Melhor-esforço: a linha da fila já foi gravada e a conversa segue sem isto;
 * o pior efeito de uma falha aqui é uma notificação esperar por template.
 */
export async function abrirJanela(msg: InboundMessage): Promise<void> {
  const at = msg.timestampMs ? new Date(msg.timestampMs) : new Date();
  try {
    await query(
      `INSERT INTO conversation_window (phone, last_inbound_at) VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE
          SET last_inbound_at = GREATEST(conversation_window.last_inbound_at, EXCLUDED.last_inbound_at)`,
      [msg.fromPhone, at]
    );
  } catch (err) {
    console.warn(
      "[janela24h] não deu pra registrar a janela:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** A pessoa escreveu nas últimas 24h? */
export async function janelaAberta(phone: string): Promise<boolean> {
  const rows = await query<{ aberta: boolean }>(
    `SELECT last_inbound_at > now() - interval '24 hours' AS aberta
       FROM conversation_window WHERE phone = $1`,
    [phone]
  );
  return rows[0]?.aberta === true;
}
