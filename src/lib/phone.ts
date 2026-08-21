/**
 * Normalização de telefone BR para E.164.
 *
 * Cópia deliberada de `apps/web/src/lib/validators/phone-br.ts` do ImobPro. Os
 * dois lados normalizam: lá para que o motivo da recusa fique no log do
 * negócio (onde alguém procura quando "o corretor não recebeu"), aqui porque
 * este serviço também recebe telefone de fora do `/notify` — o webhook da
 * Z-API, por exemplo.
 *
 * Não é sobre desconfiar do chamador: é que mandar telefone cru pro gateway já
 * causou perda SILENCIOSA de mensagem em produção (#189, e de novo no ramo de
 * corretor do Newton em 2026-08).
 */
function onlyDigits(input: string): string {
  return (input ?? "").replace(/\D/g, "");
}

export function normalizeBrPhone(raw: string): string | null {
  if (!raw) return null;
  let d = onlyDigits(raw);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    d = d.slice(2);
  }
  if (d.length !== 10 && d.length !== 11) return null;
  return `+55${d}`;
}

/** Formato que a Z-API espera: E.164 sem "+". */
export function toZapiPhone(raw: string): string | null {
  const e164 = normalizeBrPhone(raw);
  return e164 ? e164.replace(/^\+/, "") : null;
}

/**
 * Chave de CONVERSA: o telefone que identifica a mesma pessoa no `thread_id` e
 * na memória durável.
 *
 * Existe porque a ausência dela causou um bug real, encontrado no primeiro dia
 * de conversa em produção (21/08): `threadIdFor` e as funções de memória
 * recebiam o telefone CRU do chamador, e o formato varia por porta de entrada —
 * a Z-API entrega sem "+", o `normalizeBrPhone` devolve com. Resultado: a mesma
 * pessoa ganhou DUAS threads e DUAS memórias, sem erro, sem log, sem nada que
 * apontasse para o problema. Só se percebe olhando a tabela.
 *
 * **Por que sem "+" e não E.164 canônico**, já que `identity_cache` e
 * `phone_org_choice` usam com "+":
 *
 *  - `inbound_queue.from_phone` e `outbox.phone` já são sem "+" — as duas
 *    portas por onde uma conversa nasce. Escolher esta forma faz a semeadura da
 *    notificação (`seedNotification`, que recebe `outbox.phone`) cair na MESMA
 *    thread da conversa por construção, e não por coincidência de formato.
 *  - Nenhuma linha de conversa viva precisa migrar.
 *
 * As tabelas de identidade continuam em E.164 com "+" e isso está certo: elas
 * são consultadas POR telefone e nunca casadas com `thread_id`. O que não pode
 * existir é ambiguidade dentro de um mesmo eixo.
 *
 * Fallback para os dígitos crus quando não normaliza (número estrangeiro):
 * determinístico é o que importa aqui, e um número que não normaliza nunca
 * resolve identidade, então não chega a abrir thread.
 */
export function conversationKey(raw: string): string {
  return toZapiPhone(raw) ?? onlyDigits(raw ?? "");
}

/**
 * Telefone para LOG: DDI+DDD e os 4 finais, o meio mascarado.
 *
 * Log da Vercel é retido e pesquisável fora do nosso controle de acesso —
 * telefone completo ali é PII vazando para onde ninguém audita. Os 4 finais
 * bastam para correlacionar uma investigação com a linha da fila (lá o número
 * está inteiro, atrás de credencial de banco).
 */
export function maskPhone(raw: string): string {
  const d = onlyDigits(raw ?? "");
  // <= 8: com 7-8 dígitos, prefixo 4 + sufixo 4 devolveria o número inteiro
  // (ou quase) — mascarado só no nome.
  if (d.length <= 8) return "***";
  return `${d.slice(0, 4)}***${d.slice(-4)}`;
}
