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
import { createHmac } from "node:crypto";

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
 * Telefone para TELA do super-admin: DDI+DDD e os 4 finais.
 *
 * **Não use isto em log** — use `phoneTag`. As duas superfícies têm ameaças
 * opostas e por isso deixaram de compartilhar uma função só:
 *
 *  - A **tela** (`/admin/max`) fica atrás de sessão de super-admin e mostra, na
 *    linha de cima, a transcrição inteira da conversa. O telefone é o dado
 *    MENOS sensível ali, e os 4 finais são o que permite casar o turn com a
 *    carteira de corretores do tenant. Endurecer aqui não protege nada.
 *  - O **log** é retido e pesquisável fora do nosso controle de acesso, e lá
 *    esta máscara é fraca: em celular BR ela esconde 5 dígitos, mas o primeiro
 *    é sempre `9` — sobram ~10 mil combinações, e dentro de uma carteira de
 *    dezenas de pessoas os 4 finais já identificam.
 */
export function maskPhone(raw: string): string {
  const d = onlyDigits(raw ?? "");
  // <= 8: com 7-8 dígitos, prefixo 4 + sufixo 4 devolveria o número inteiro
  // (ou quase) — mascarado só no nome.
  if (d.length <= 8) return "***";
  return `${d.slice(0, 4)}***${d.slice(-4)}`;
}

/**
 * Rótulo de telefone para LOG: pseudônimo derivado por HMAC, irreversível sem
 * a chave.
 *
 * O que o log precisa é **correlação**, não legibilidade do número: seguir a
 * mesma pessoa entre `inbound.aceito`, `turn.respondido` e `outbox.enviado`. O
 * pseudônimo faz isso igual — e, ao contrário da máscara, não vaza dígito
 * nenhum se o log escapar. Sem chave, o espaço de telefones brasileiros é
 * pequeno o bastante para um hash puro ser quebrado por força bruta em
 * segundos; com chave, não é.
 *
 * **Como investigar com ele:** você quase sempre parte do número (alguém
 * reclamou). Rode `npx tsx scripts/tel.ts <telefone>`, que imprime o rótulo, e
 * busque por ele. O caminho inverso não existe de propósito.
 *
 * Derivado sobre `conversationKey`, e não sobre o texto cru, para que toda
 * forma de escrever o mesmo número caia no MESMO rótulo — se dependesse do
 * formato, o pseudônimo repetiria o bug de identidade de 21/08 dentro do log.
 *
 * A chave sai do `MAX_NOTIFY_SECRET` com separação de domínio (`phone-tag-v1`),
 * em vez de uma variável nova: uma env a menos para esquecer de configurar, e o
 * segredo de autenticação nunca é usado diretamente para outra finalidade.
 * Consequência que precisa estar escrita: **rotacionar o segredo troca todos os
 * rótulos**, então uma investigação não atravessa a rotação. É aceitável porque
 * a retenção do log é curta e a rotação é rara — mas quem rotacionar tem que
 * saber.
 *
 * 10 hex = 40 bits: com 100 mil telefones distintos, a chance de dois
 * colidirem é ~0,5%. Suficiente, e curto o bastante para caber no olho.
 */
export function phoneTag(raw: string): string {
  const chave = conversationKey(raw ?? "");
  if (!chave) return "tel_vazio";
  const segredo = process.env.MAX_NOTIFY_SECRET;
  const derivada = createHmac("sha256", segredo || SEM_SEGREDO)
    .update("phone-tag-v1")
    .digest();
  const hash = createHmac("sha256", derivada).update(chave).digest("hex").slice(0, 10);
  // Prefixo diferente sem segredo: ver SEM_SEGREDO.
  return `${segredo ? "tel" : "telx"}_${hash}`;
}

/**
 * Chave de desenvolvimento, para quando o `MAX_NOTIFY_SECRET` não existe.
 *
 * Em produção ele sempre existe — é o que autentica o `/notify`, sem o qual
 * este serviço não recebe nada. Mas "sempre" aqui vale para o processo que
 * atende a rota, e não necessariamente para todo processo que loga: cron,
 * script e worker também chamam `log`. Se um deles rodasse sem o segredo, o
 * rótulo sairia derivado de uma chave CONSTANTE E VERSIONADA — ou seja, sem
 * chave nenhuma na prática, e quebrável por força bruta em segundos, que é
 * exatamente o que esta função existe para impedir.
 *
 * Por isso o prefixo muda para `telx_`: o modo de falha deixa de ser silencioso
 * e vira visível no próprio log. Um `telx_` em produção é um bug de
 * configuração para consertar, não um rótulo para investigar.
 *
 * A chave é constante (e não aleatória por processo) porque um rótulo que muda
 * a cada invocação não correlaciona nada — e correlacionar é o único motivo de
 * a função existir.
 */
const SEM_SEGREDO = "sem-segredo-fora-de-producao";
