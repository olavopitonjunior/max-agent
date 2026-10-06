/**
 * O que acontece ANTES do grafo quando a pessoa responde a um template que
 * pede resposta — régua do Olavo, 01/10/2026:
 *
 *  1. **OK → entrega.** A mensagem da imobiliária (e o repasse de dúvida ao
 *     time) sai como template "tem uma mensagem para você — responda OK". O
 *     texto escrito fica em `outbox.body`; quando o OK chega, a janela de 24h
 *     acabou de abrir (o inbound a abre ao ser aceito) e o texto sai livre.
 *  2. **"Tenho uma dúvida" → repasse.** No lembrete de configuração pendente,
 *     o toque abre um `pending_handoff`; a PRÓXIMA mensagem da pessoa é a
 *     dúvida, e vai para o telefone do time (`MAX_ESCALATION_PHONE`) — também
 *     como template + OK, porque o time não está na janela.
 *
 * Roda antes da IDENTIDADE de propósito: a parte do negócio é desconhecida
 * para o Max (não é usuário de nenhuma org), e é ela quem mais recebe a
 * mensagem da imobiliária. Nada aqui chama modelo.
 *
 * Nenhum dos dois caminhos é adivinhado pelo texto livre: o OK só entrega o
 * que foi enviado como template a ESTE telefone, e a dúvida só é capturada
 * depois do toque (ou da frase do botão) em resposta a um lembrete recente.
 * Fora disso a mensagem segue para a conversa normal.
 */

import { query } from "./db";
import { enqueue } from "./outbox";
import { log } from "./log";
import { destinoPermitido } from "./redirect";
import { KINDS_COM_ACEITE, templatesDoKind } from "./templates/catalog";
import type { InboundMessage } from "./transport";
import { SEM_ORG } from "./sem-org";

/** Kinds cujo texto só é entregue depois do OK (ver o catálogo). */
export { KINDS_COM_ACEITE };

/** Quanto tempo um OK ainda entrega uma mensagem guardada. */
const VALIDADE_ACEITE_DIAS = 7;

/**
 * As 3 ações dos botões de proposta (`catalog.ts`, PR 3) — mesmo enum do
 * `AcaoBotao`, repetido aqui como literais para não importar o catálogo só
 * por um tipo. A ação de VERDADE (converter, recriar) é o PR 6: por ora só
 * valida o clique e responde com texto fixo.
 */
const ACOES_VALIDAS = ["converter", "agora_nao", "recriar"] as const;
type AcaoBotaoPayload = (typeof ACOES_VALIDAS)[number];

/**
 * `kind`s compatíveis com cada ação. Mora aqui, não no catálogo: o catálogo
 * diz qual BOTÃO existe no template; quem pode responder a ele é regra do
 * aceite — um `acao:<id>:converter` só vale se a linha é mesmo
 * `proposal_completed` (ver ponto 4 do PR 3).
 */
const KINDS_DA_ACAO: Record<AcaoBotaoPayload, readonly string[]> = {
  converter: ["proposal_completed"],
  agora_nao: ["proposal_completed"],
  recriar: ["proposal_refused", "proposal_expired"],
};

/**
 * `acao:<rowId>:<ação>` → `{ rowId, acao }`, ou `null` se malformado ou com
 * ação fora do enum — tratado como payload desconhecido (ignora, cai no
 * caminho normal da mensagem, igual a hoje).
 */
function parsePayloadDeAcao(payload: string): { rowId: string; acao: AcaoBotaoPayload } | null {
  const m = /^acao:([^:]+):([a-z_]+)$/.exec(payload);
  if (!m) return null;
  const [, rowId, acao] = m;
  if (!(ACOES_VALIDAS as readonly string[]).includes(acao)) return null;
  return { rowId, acao: acao as AcaoBotaoPayload };
}

/**
 * Texto FIXO — nunca chama o modelo. A ação de verdade (converter/recriar)
 * chega no PR 6; por ora só orienta pelo link absoluto da linha.
 */
function respostaDaAcao(acao: AcaoBotaoPayload, linkUrl: string | null): string {
  if (acao === "agora_nao") return "Tudo bem. A proposta continua no sistema.";
  const verbo = acao === "converter" ? "converter a proposta em negócio" : "recriar a proposta";
  // O mesmo filtro do redirecionador `/r/<id>`: só link nosso (o /notify
  // aceita `linkUrl` livre). Fora disso, ou nulo, a resposta sai sem link.
  const link = destinoPermitido(linkUrl);
  return link
    ? `Para ${verbo}, abra a proposta pelo link: ${link.toString()}`
    : `Para ${verbo}, abra a proposta no ImobPro.`;
}

/**
 * Clique num botão de AÇÃO. Valida, na mesma regra do `ok:` (ver `liberar`):
 * (a) a linha existe; (b) foi enviada a ESTE telefone; (c) o `kind` da linha
 * é compatível com a ação; (d) dentro da mesma janela de validade do OK
 * (`VALIDADE_ACEITE_DIAS`). Fora disso, resposta neutra fixa — igual não
 * revela SE a linha existe, se é de outro telefone, ou se já venceu.
 *
 * É uma LEITURA: nada é marcado como consumido, então a reentrega do mesmo
 * clique (webhook duplicado) responde sempre igual — idempotente de
 * propósito, sem precisar de trava.
 */
async function responderAcao(
  inbound: InboundMessage,
  rowId: string,
  acao: AcaoBotaoPayload
): Promise<Interceptado> {
  const linhas = await query<{ kind: string | null; link_url: string | null; org_id: string }>(
    `SELECT kind, link_url, org_id FROM outbox
      WHERE id = $1 AND phone = $2
        AND status = 'sent' AND template_name IS NOT NULL
        AND sent_at > now() - ($3 || ' days')::interval`,
    [rowId, inbound.fromPhone, String(VALIDADE_ACEITE_DIAS)]
  );
  const linha = linhas[0];
  const valido = !!linha?.kind && KINDS_DA_ACAO[acao].includes(linha.kind);
  if (!valido) {
    log.info("aceite.acao_sem_pendencia", { phone: inbound.fromPhone, acao, rowId });
    return {
      reply: "Esse botão não está mais disponível.",
      orgId: null,
      marca: "acao_sem_pendencia",
    };
  }
  log.info(`aceite.acao_${acao}_pendente`, { phone: inbound.fromPhone, orgId: linha.org_id, rowId });
  return {
    reply: respostaDaAcao(acao, linha.link_url),
    orgId: linha.org_id,
    marca: `acao_${acao}_pendente`,
  };
}
/** Quanto tempo depois do lembrete a frase "tenho uma dúvida" vale. */
const VALIDADE_LEMBRETE_DIAS = 3;
/** Quanto tempo a pessoa tem para escrever a dúvida depois do toque. */
const VALIDADE_DUVIDA_HORAS = 24;

/** "ok", "OK!", "Ok." — e nada mais. "ok, mas e o contrato?" é conversa. */
export function ehOk(texto: string): boolean {
  return /^\s*ok(ay)?[\s.!]*$/i.test(texto);
}

/** O texto do botão, digitado à mão. */
export function ehPedidoDeDuvida(texto: string): boolean {
  return /^\s*tenho\s+uma\s+d[uú]vida[\s.!]*$/i.test(texto);
}

export interface Interceptado {
  reply: string;
  orgId: string | null;
  /** Marca no rastro do turn (`conversation_turn.error`) — não é erro. */
  marca: string;
}

interface Pendente extends Record<string, unknown> {
  id: string;
  org_id: string;
  org_name: string;
  title: string;
  body: string;
}

/**
 * Teto do que um OK entrega numa resposta. O envio corta em 4096 caracteres
 * (`meta.ts`) e o que passasse disso sumiria com a linha marcada como
 * entregue; o que não cabe fica para o próximo OK.
 */
const TETO_ENTREGA = 3500;

/** Repasses de dúvida por pessoa em 24h — cada um é um template pago. */
const TETO_REPASSES_DIA = 3;

/**
 * Número que nenhuma imobiliária reconhece: UM repasse por dia (decisão do
 * Olavo, 05/10/2026). Ele já recebeu a apresentação ("fale com seu
 * corretor"); se insiste, a segunda mensagem vai para a equipe, e o resto do
 * dia segue em silêncio — visível em Conversas → "Sem imobiliária".
 */
const TETO_REPASSES_DESCONHECIDO_DIA = 1;

/**
 * Teto GLOBAL de repasses de desconhecidos por dia: o teto por número não
 * segura quem tem muitos números (ou uma onda de spam), e cada repasse é um
 * template pago para a equipe.
 */
const TETO_REPASSES_DESCONHECIDOS_DIA_TOTAL = 10;

/** Como o repasse aparece no template ("{{2}}, da {{3}}, mandou…"). */
const ORG_DO_DESCONHECIDO = "imobiliária não identificada";

/**
 * Repassa a mensagem de um número desconhecido para a equipe, pelo MESMO
 * caminho da dúvida de onboarding (`support_handoff`, telefone do time). Antes
 * (até 05/10) o Max só silenciava: quem procurava um corretor ficava sem
 * resposta nenhuma (o caso do Luiz Gustavo, 8 mensagens em 03/09).
 *
 * `null` = segue o silêncio (sem texto, sem destino, ou teto do dia usado).
 */
export async function repassarDesconhecido(
  inbound: InboundMessage
): Promise<{ reply: string; marca: string } | null> {
  const texto = inbound.text?.trim() ?? "";
  if (!texto) return null;
  const destino = (process.env.MAX_ESCALATION_PHONE ?? "").replace(/\D/g, "");
  if (!destino) return null;
  // O próprio telefone da equipe sem cadastro não repassa para si mesmo.
  if (inbound.fromPhone.replace(/\D/g, "") === destino) return null;

  const dedupeKey = `handoff:${inbound.messageId}`;
  const total = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox
      WHERE kind = 'support_handoff' AND params->>'desconhecido' = '1'
        AND dedupe_key <> $1
        AND created_at > now() - interval '1 day'`,
    [dedupeKey]
  );
  if ((total[0]?.n ?? 0) >= TETO_REPASSES_DESCONHECIDOS_DIA_TOTAL) {
    log.warn("aceite.desconhecido_teto_global", { phone: inbound.fromPhone });
    return null;
  }
  const recentes = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox
      WHERE kind = 'support_handoff' AND params->>'de' = $1
        AND dedupe_key <> $2
        AND created_at > now() - interval '1 day'`,
    [inbound.fromPhone, dedupeKey]
  );
  if ((recentes[0]?.n ?? 0) >= TETO_REPASSES_DESCONHECIDO_DIA) return null;

  /**
   * Parte de negócio também é `unknown` para a identidade, mas recebeu aviso
   * de uma imobiliária: o repasse leva o nome dela, para a equipe saber a
   * quem encaminhar.
   */
  const origem = await query<{ org_id: string; org_name: string }>(
    `SELECT org_id, org_name FROM outbox
      WHERE phone = $1 AND org_id <> $2
        AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 1`,
    [inbound.fromPhone, SEM_ORG]
  );
  const org = origem[0];
  const quem = (inbound.senderName?.trim() || "Um contato").slice(0, 40);
  await enqueue({
    orgId: org?.org_id ?? SEM_ORG,
    // Idempotente pela mensagem: a reentrega do webhook não repassa duas vezes.
    dedupeKey,
    audience: "platform_user",
    phone: destino,
    recipientName: process.env.MAX_ESCALATION_NAME || "equipe",
    title: "Mensagem de número sem cadastro",
    body: org
      ? `${quem} (+${inbound.fromPhone}), que recebeu aviso da ${org.org_name}, escreveu ao Max ` +
        `de um número sem cadastro:\n\n${texto}`
      : `${quem} (+${inbound.fromPhone}) escreveu ao Max de um número que nenhuma ` +
        `imobiliária reconhece:\n\n${texto}`,
    linkUrl: null,
    dealId: null,
    orgName: org?.org_name || ORG_DO_DESCONHECIDO,
    kind: "support_handoff",
    // `desconhecido` conta o teto global; `de` deixa o esquecimento alcançar a linha.
    params: { quem, de: inbound.fromPhone, desconhecido: "1" },
  });
  log.info("aceite.desconhecido_repassado", { phone: inbound.fromPhone });
  return {
    reply: "Passei sua mensagem para a nossa equipe, que vai falar com você em breve.",
    marca: "desconhecido_repassado",
  };
}

/**
 * Entrega o que estava guardado para este telefone, do mais antigo ao mais
 * novo, até o teto.
 *
 * A trava é `released_at IS NULL OR released_by = <esta mensagem>`:
 *  - um OK repetido (outra mensagem) não reencontra o que já saiu;
 *  - a RETENTATIVA desta mesma mensagem reencontra — se o turn morreu entre
 *    liberar e responder, o texto sai na retentativa em vez de se perder com
 *    a linha marcada como entregue.
 *
 * Só linhas que saíram como TEMPLATE (`template_name` não nulo): dentro da
 * janela a mensagem já foi entregue inteira, como texto livre.
 *
 * `soSemConversaDepois` (OK DIGITADO): não libera o que saiu antes de um turn
 * que passou pelo modelo. Esse "ok" quase sempre responde ao Max — uma
 * confirmação de ação pendente — e não ao template de dias atrás. O toque no
 * botão não tem essa ambiguidade: o payload diz a qual linha responde.
 */
async function liberar(
  phone: string,
  messageId: string,
  o: { rowId: string | null; soSemConversaDepois: boolean }
): Promise<{ entregues: Pendente[]; restantes: number }> {
  const candidatas = await query<{ id: string; tamanho: number }>(
    `SELECT id, length(body) AS tamanho FROM outbox o
      WHERE phone = $1
        AND kind = ANY($2::text[])
        AND status = 'sent'
        AND template_name IS NOT NULL
        AND (released_at IS NULL OR released_by = $3)
        AND sent_at > now() - ($4 || ' days')::interval
        AND ($5::text IS NULL OR id = $5)
        AND (NOT $6 OR NOT EXISTS (
              SELECT 1 FROM conversation_turn t
               WHERE t.phone = o.phone
                 AND t.created_at > o.sent_at
                 AND t.usage_json <> '[]'::jsonb
                 AND t.message_id IS DISTINCT FROM $3))
      ORDER BY sent_at, id`,
    [
      phone,
      [...KINDS_COM_ACEITE],
      messageId,
      String(VALIDADE_ACEITE_DIAS),
      o.rowId,
      o.soSemConversaDepois,
    ]
  );

  const entregues: Pendente[] = [];
  let total = 0;
  let restantes = 0;
  for (const c of candidatas) {
    // A primeira sempre sai (o envio a corta se for enorme); as seguintes só
    // se couberem.
    if (entregues.length > 0 && total + c.tamanho > TETO_ENTREGA) {
      restantes += 1;
      continue;
    }
    const r = await query<Pendente>(
      `UPDATE outbox
          SET released_at = COALESCE(released_at, now()), released_by = $2
        WHERE id = $1 AND (released_at IS NULL OR released_by = $2)
        RETURNING id, org_id, org_name, title, body`,
      [c.id, messageId]
    );
    if (r[0]) {
      entregues.push(r[0]);
      total += c.tamanho;
    }
  }
  return { entregues, restantes };
}

function textoEntregue(p: Pendente): string {
  const de = p.org_name ? `Mensagem da ${p.org_name}` : "Mensagem";
  return `*${de}*\n\n${p.body.trim()}`;
}

function respostaDaEntrega(entregues: Pendente[], restantes: number): Interceptado {
  let reply = entregues.map(textoEntregue).join("\n\n");
  if (restantes > 0) {
    reply +=
      restantes === 1
        ? "\n\nHá mais uma mensagem para você. Responda OK para ver."
        : `\n\nHá mais ${restantes} mensagens para você. Responda OK para ver a próxima.`;
  }
  return { reply, orgId: entregues[0].org_id, marca: "aceite_entregue" };
}

/** Abre o repasse: a próxima mensagem desta pessoa é a dúvida. */
async function abrirRepasse(phone: string, rowId: string | null): Promise<Interceptado | null> {
  const lembrete = await query<{ org_id: string; org_name: string; recipient_name: string }>(
    `SELECT org_id, org_name, recipient_name FROM outbox
      WHERE phone = $1 AND kind = 'onboarding_pending' AND status = 'sent'
        AND sent_at > now() - ($2 || ' days')::interval
        AND ($3::text IS NULL OR id = $3)
      ORDER BY sent_at DESC LIMIT 1`,
    [phone, String(VALIDADE_LEMBRETE_DIAS), rowId]
  );
  const l = lembrete[0];
  if (!l) return null;
  await query(
    `INSERT INTO pending_handoff (phone, org_id, org_name, requester_name, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
     ON CONFLICT (phone) DO UPDATE
        SET org_id = EXCLUDED.org_id, org_name = EXCLUDED.org_name,
            requester_name = EXCLUDED.requester_name, created_at = now(),
            expires_at = EXCLUDED.expires_at, consumed_by = NULL`,
    [phone, l.org_id, l.org_name, l.recipient_name, String(VALIDADE_DUVIDA_HORAS)]
  );
  return {
    reply:
      "Claro! Escreva sua dúvida aqui, numa mensagem só, que eu passo direto " +
      "para a nossa equipe.",
    orgId: l.org_id,
    marca: "duvida_aberta",
  };
}

/**
 * A dúvida chegou: vai para o time como template + OK (o time não está na
 * janela de 24h), e a pessoa fica sabendo.
 *
 * Ordem pensada para a retentativa (o turn pode morrer em qualquer ponto):
 *  1. lê o pedido — vivo, ou já consumido por ESTA mensagem;
 *  2. sem destino configurado: avisa e NÃO consome — a pessoa tenta de novo;
 *  3. enfileira (idempotente por `handoff:<wamid>`);
 *  4. só então marca o pedido consumido por esta mensagem.
 * Morrer entre 3 e 4 é inofensivo: a retentativa reencontra o pedido e o
 * enqueue vira duplicata.
 */
async function repassar(inbound: InboundMessage, texto: string): Promise<Interceptado | null> {
  const abertos = await query<{
    org_id: string;
    org_name: string;
    requester_name: string;
    valido: boolean;
  }>(
    `SELECT org_id, org_name, requester_name,
            (expires_at > now() OR consumed_by = $2) AS valido
       FROM pending_handoff
      WHERE phone = $1 AND (consumed_by IS NULL OR consumed_by = $2)`,
    [inbound.fromPhone, inbound.messageId]
  );
  const h = abertos[0];
  if (!h) return null;
  if (!h.valido) {
    // Vencido: some, e a conversa segue normal.
    await query(`DELETE FROM pending_handoff WHERE phone = $1 AND consumed_by IS NULL`, [
      inbound.fromPhone,
    ]);
    return null;
  }

  const destino = (process.env.MAX_ESCALATION_PHONE ?? "").replace(/\D/g, "");
  if (!destino) {
    console.error("[aceite] MAX_ESCALATION_PHONE ausente — dúvida não repassada");
    return {
      reply:
        "Não consegui passar sua dúvida para a equipe agora. Pode tentar de " +
        "novo em alguns minutos?",
      orgId: h.org_id,
      marca: "duvida_sem_destino",
    };
  }

  const recentes = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox
      WHERE kind = 'support_handoff' AND params->>'de' = $1
        AND dedupe_key <> $2
        AND created_at > now() - interval '1 day'`,
    [inbound.fromPhone, `handoff:${inbound.messageId}`]
  );
  if ((recentes[0]?.n ?? 0) >= TETO_REPASSES_DIA) {
    await query(
      `UPDATE pending_handoff SET consumed_by = $2 WHERE phone = $1 AND consumed_by IS NULL`,
      [inbound.fromPhone, inbound.messageId]
    );
    log.warn("aceite.duvida_teto", { orgId: h.org_id, phone: inbound.fromPhone });
    return {
      reply:
        "Já passei suas dúvidas de hoje para a nossa equipe, que vai falar com " +
        "você em breve.",
      orgId: h.org_id,
      marca: "duvida_teto",
    };
  }

  const quem = h.requester_name || inbound.senderName || "Um cliente";
  await enqueue({
    orgId: h.org_id,
    // Idempotente pela mensagem: a reentrega do webhook não repassa duas vezes.
    dedupeKey: `handoff:${inbound.messageId}`,
    audience: "platform_user",
    phone: destino,
    recipientName: process.env.MAX_ESCALATION_NAME || "equipe",
    title: "Dúvida de configuração",
    body:
      `Dúvida de ${quem} (${h.org_name || h.org_id}, +${inbound.fromPhone}):\n\n` +
      texto.trim(),
    linkUrl: null,
    dealId: null,
    orgName: h.org_name,
    kind: "support_handoff",
    // `de` não vai para o template: é o que deixa o esquecimento desta
    // pessoa alcançar a linha, que mora no telefone do time.
    params: { quem, de: inbound.fromPhone },
  });
  await query(
    `UPDATE pending_handoff SET consumed_by = $2 WHERE phone = $1 AND consumed_by IS NULL`,
    [inbound.fromPhone, inbound.messageId]
  );
  log.info("aceite.duvida_repassada", { orgId: h.org_id, phone: inbound.fromPhone });
  return {
    reply:
      "Recebi! Passei sua dúvida para a nossa equipe, que vai falar com você " +
      "em breve.",
    orgId: h.org_id,
    marca: "duvida_repassada",
  };
}

/**
 * A apresentação do Max saiu do template de boas-vindas (o v2 é só
 * transacional — a Meta classificava a apresentação como MARKETING) e vai aqui:
 * na PRIMEIRA mensagem da pessoa depois das boas-vindas que saíram por um
 * template posterior ao v1 (v2 em diante), o Max responde com o texto de `body` (montado pelo
 * contractmaker em `lib/max/boas-vindas.ts`: apresentação + "faça o primeiro
 * acesso pelo link do e-mail" + "é só perguntar" — não depende do botão).
 *
 * - Nunca o v1: ele já trazia a apresentação; repetir seria a segunda vez.
 * - Só se ainda não houve conversa depois das boas-vindas (o mesmo critério do
 *   OK): quem já falou com o Max — inclusive por áudio, que não passa aqui —
 *   não recebe apresentação no meio da conversa.
 * - Uma vez por PESSOA: consome TODAS as boas-vindas pendentes do telefone
 *   (convite reenviado, duas imobiliárias) e responde com a mais recente.
 * - Só para cumprimento ("oi", "bom dia"): uma pergunta de verdade segue para
 *   o grafo e é respondida — a apresentação é consumida em silêncio, em vez de
 *   engolir a pergunta com um texto pronto.
 * - Retentativa da mesma mensagem reencontra o mesmo desfecho
 *   (`released_by` = message_id).
 */
const VALIDADE_APRESENTACAO_DIAS = 7;
/** O template de boas-vindas SEM apresentação — o primeiro de `welcome`. */
/** Só o v1 trazia a apresentação; qualquer versão posterior a deixa para cá. */
const BOAS_VINDAS_V1 = templatesDoKind("welcome").at(-1)?.name ?? "max_boas_vindas";

/** Curto e sem pergunta: cumprimento, "ok", "obrigado". */
export function ehCumprimento(texto: string): boolean {
  const t = texto.trim();
  return t.length > 0 && !t.includes("?") && t.split(/\s+/).length <= 4;
}

async function apresentacaoPendente(
  phone: string,
  messageId: string,
  texto: string
): Promise<Interceptado | null> {
  const r = await query<{ org_id: string; body: string; sent_at: Date }>(
    `WITH alvo AS (
       SELECT o.id FROM outbox o
        WHERE o.phone = $1 AND o.kind = 'welcome' AND o.status = 'sent'
          AND o.template_name IS NOT NULL AND o.template_name <> $4
          AND (o.released_at IS NULL OR o.released_by = $2)
          AND o.sent_at > now() - ($3 || ' days')::interval
          AND NOT EXISTS (
                SELECT 1 FROM conversation_turn t
                 WHERE t.phone = o.phone
                   AND t.created_at > o.sent_at
                   AND t.message_id IS DISTINCT FROM $2)
        ORDER BY o.id
        FOR UPDATE)
     UPDATE outbox u
        SET released_at = COALESCE(u.released_at, now()), released_by = $2
       FROM alvo
      WHERE u.id = alvo.id
        AND (u.released_at IS NULL OR u.released_by = $2)
      RETURNING u.org_id, u.body, u.sent_at`,
    [phone, messageId, String(VALIDADE_APRESENTACAO_DIAS), BOAS_VINDAS_V1]
  );
  if (r.length === 0) return null;
  const a = r.reduce((x, y) => (new Date(y.sent_at) > new Date(x.sent_at) ? y : x));
  if (!ehCumprimento(texto) || !a.body.trim()) {
    log.info("aceite.apresentacao_consumida", { orgId: a.org_id, motivo: "pergunta" });
    return null;
  }
  return { reply: a.body.trim(), orgId: a.org_id, marca: "apresentacao_entregue" };
}

/** Pedidos de dúvida vencidos ou já consumidos — carona no cron horário. */
export async function podarPedidosDeDuvida(): Promise<number> {
  const r = await query<{ phone: string }>(
    `DELETE FROM pending_handoff
      WHERE expires_at < now() - interval '1 day'
      RETURNING phone`
  );
  return r.length;
}

/**
 * `null` = nada a fazer aqui, a mensagem segue para a identidade e o grafo.
 */
export async function interceptar(inbound: InboundMessage): Promise<Interceptado | null> {
  const texto = inbound.text?.trim() ?? "";
  const payload = inbound.buttonPayload ?? null;

  // 1. Toque em botão: o payload diz exatamente a qual mensagem responde.
  if (payload?.startsWith("ok:")) {
    const { entregues, restantes } = await liberar(inbound.fromPhone, inbound.messageId, {
      rowId: payload.slice(3),
      soSemConversaDepois: false,
    });
    if (entregues.length > 0) return respostaDaEntrega(entregues, restantes);
    return {
      reply: "Essa mensagem já foi entregue ou não está mais disponível.",
      orgId: null,
      marca: "aceite_sem_pendencia",
    };
  }
  if (payload?.startsWith("duvida:")) {
    return abrirRepasse(inbound.fromPhone, payload.slice(7));
  }
  if (payload?.startsWith("acao:")) {
    const parsed = parsePayloadDeAcao(payload);
    // Malformado ou ação fora do enum: ignora, como hoje ignora payload
    // desconhecido — segue para o caminho normal da mensagem.
    if (parsed) return responderAcao(inbound, parsed.rowId, parsed.acao);
  }

  // 2. O botão digitado à mão — ANTES do repasse, senão a própria frase
  //    "tenho uma dúvida" viraria a dúvida.
  if (ehPedidoDeDuvida(texto)) {
    const aberto = await abrirRepasse(inbound.fromPhone, null);
    if (aberto) return aberto;
  }

  // 3. A dúvida que chegou depois do toque.
  if (texto && !ehOk(texto)) {
    const repasse = await repassar(inbound, texto);
    if (repasse) return repasse;
  }

  // 4. OK digitado.
  if (ehOk(texto)) {
    const { entregues, restantes } = await liberar(inbound.fromPhone, inbound.messageId, {
      rowId: null,
      soSemConversaDepois: true,
    });
    if (entregues.length > 0) return respostaDaEntrega(entregues, restantes);
    // Nada guardado: "ok" é só conversa.
  }

  // 5. Primeira mensagem depois das boas-vindas por template: a apresentação.
  if (texto) {
    const apresentacao = await apresentacaoPendente(inbound.fromPhone, inbound.messageId, texto);
    if (apresentacao) return apresentacao;
  }
  return null;
}
