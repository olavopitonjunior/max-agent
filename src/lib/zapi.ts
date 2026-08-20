/**
 * Cliente Z-API.
 *
 * Portado de `whatsapp-newton-bridge/src/lib/z-api.ts`, que já está batido
 * contra a API real em produção há meses. As peculiaridades do provedor
 * documentadas lá foram preservadas — cada uma custou uma investigação:
 *
 *  - `momment` (sic) é o timestamp, com o typo do provedor, em MILISSEGUNDOS;
 *  - em grupo, `phone` é o JID do GRUPO e quem falou vem em `participantPhone`;
 *  - menção moderna do WhatsApp vem como LID, não como telefone;
 *  - URL de mídia é pública, sem auth, e expira em ~30 dias;
 *  - **instância desemparelhada responde HTTP 200 com `messageId` válido e não
 *    entrega nada** — status code não é prova de entrega.
 *
 * Z-API é não-oficial (liga por QR, como o WhatsApp Web). Em troca de não
 * depender da verificação de negócio da Meta, não há janela de 24h nem
 * template: texto livre a qualquer hora, e grupo funciona também no envio.
 */

import { fetchWithTimeout, ZAPI_TIMEOUT_MS } from "./http";

const BASE_URL = "https://api.z-api.io";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} não configurada`);
  return v;
}

function instanceBase(): string {
  return `${BASE_URL}/instances/${env("ZAPI_INSTANCE_ID")}/token/${env("ZAPI_INSTANCE_TOKEN")}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // Obrigatório depois de gerado no painel; sem ele a Z-API recusa.
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;
  if (clientToken) h["Client-Token"] = clientToken;
  return h;
}

export interface ZApiSendResponse {
  zaapId?: string;
  messageId?: string;
  id?: string;
}

/** Aceita telefone E.164 sem "+" ou JID de grupo (`<dígitos>-group`). */
export function isGroupJid(to: string): boolean {
  return /^\d{1,25}(?:-\d{1,25})?-group$/.test(to) || /@g\.us$/i.test(to);
}

async function post(path: string, body: unknown): Promise<ZApiSendResponse> {
  const res = await fetchWithTimeout(
    `${instanceBase()}${path}`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    },
    ZAPI_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Z-API ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json().catch(() => ({}))) as ZApiSendResponse;
}

export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
}): Promise<ZApiSendResponse> {
  return post("/send-text", {
    phone: params.to,
    message: params.body,
    ...(params.quoteMessageId ? { messageId: params.quoteMessageId } : {}),
  });
}

/**
 * Manda como VOICE NOTE (`waveform: true` — a bolinha com onda, igual a áudio
 * gravado por gente), não como anexo de arquivo. A Z-API aceita data-URI
 * base64, então não é preciso hospedar o arquivo em lugar nenhum.
 */
export async function sendAudio(params: {
  to: string;
  audio: Buffer;
  mime?: string;
  quoteMessageId?: string;
}): Promise<ZApiSendResponse> {
  const mime = params.mime ?? "audio/mpeg";
  return post("/send-audio", {
    phone: params.to,
    audio: `data:${mime};base64,${params.audio.toString("base64")}`,
    waveform: true,
    ...(params.quoteMessageId ? { messageId: params.quoteMessageId } : {}),
  });
}

/**
 * Teto do que aceitamos baixar.
 *
 * Amarrado ao limite do outro lado: o `/api/agents/media/transcribe` do ImobPro
 * recusa acima de 3 MB, e o corpo da Vercel para em 4.5 MB com base64 inflando
 * 33%. Baixar 20 MB de vídeo pra tomar 413 depois é gastar banda e latência
 * pra chegar no mesmo "não deu".
 */
export const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

/**
 * Baixa a mídia de uma mensagem recebida.
 *
 * A URL vem do webhook da Z-API e é lida como DADO — só o `content-length` e os
 * bytes interessam. Nada do que vier aqui vira instrução, e o conteúdo é
 * repassado ao ImobPro como binário, nunca como link (lá isso seria SSRF com
 * credencial de tenant).
 *
 * `null` em qualquer problema: mídia é melhor-esforço, e quem chama tem que
 * saber dizer "não consegui ouvir" em vez de calar.
 */
export async function downloadMedia(
  url: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  try {
    const res = await fetchWithTimeout(url, {}, ZAPI_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[zapi] download de mídia ${res.status}`);
      return null;
    }

    // Recusa pelo cabeçalho ANTES de puxar o corpo, quando ele existe: é a
    // diferença entre desistir de graça e desistir depois de baixar tudo.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_MEDIA_BYTES) {
      console.warn(`[zapi] mídia grande demais (${declared} bytes) — ignorada`);
      return null;
    }

    const data = Buffer.from(await res.arrayBuffer());
    // Conferido de novo sobre o real: `content-length` pode faltar ou mentir.
    if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
      console.warn(`[zapi] mídia fora do limite (${data.byteLength} bytes)`);
      return null;
    }

    return { data, contentType: res.headers.get("content-type") };
  } catch (err) {
    console.error(
      "[zapi] download de mídia falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Estado da instância. É o ÚNICO jeito de saber se as mensagens estão mesmo
 * saindo: desemparelhada, a Z-API aceita o `send-text` com 200 e um
 * `messageId` que nunca chega a lugar nenhum.
 */
export async function connectionStatus(): Promise<{
  connected: boolean;
  session?: string;
  raw: unknown;
}> {
  const res = await fetchWithTimeout(
    `${instanceBase()}/status`,
    { method: "GET", headers: headers() },
    ZAPI_TIMEOUT_MS
  );

  /**
   * Resposta não-2xx LANÇA. Antes não checava `res.ok`, e isso produzia um
   * diagnóstico errado com cara de certo.
   *
   * Um 401/403 (Client-Token da conta trocado), um 404 (instance id errado) ou
   * um 5xx devolvem um corpo SEM o campo `connected` — e `Boolean(undefined)` é
   * `false`. Ou seja: qualquer falha de credencial ou de rota era carimbada na
   * fila como **"instância desemparelhada"**, que manda quem for investigar
   * pegar o celular e ler um QR code que não vai resolver nada.
   *
   * Custou uma tarde: a instância foi re-pareada mais de uma vez enquanto a
   * causa podia ser outra, e a fila ficou represada em silêncio com a
   * explicação errada colada nela.
   *
   * Lançar é o comportamento certo porque os dois chamadores já distinguem os
   * casos: eles tratam exceção como "não consegui PERGUNTAR" e seguem (fail
   * open), registrando o motivo real no log. É a mesma regra do `orgById` —
   * atalho pode confirmar o acerto, nunca decretar o negativo.
   */
  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    throw new Error(
      `Z-API /status ${res.status} — NÃO é desemparelhamento, é a chamada ` +
        `falhando (confira ZAPI_INSTANCE_ID/ZAPI_TOKEN/ZAPI_CLIENT_TOKEN): ` +
        corpo.slice(0, 200)
    );
  }

  const raw = await res.json().catch(() => null);
  const p = (raw ?? {}) as {
    connected?: boolean;
    smartphoneConnected?: boolean;
    session?: string;
  };

  /**
   * 200 sem NENHUM dos dois campos também não é "desconectado" — é um formato
   * que este código não entende. Tratar como desconectado repetiria, mais de
   * leve, o mesmo erro de cima.
   */
  if (p.connected === undefined && p.smartphoneConnected === undefined) {
    throw new Error(
      `Z-API /status 200 sem campo de conexão — formato inesperado: ` +
        JSON.stringify(raw).slice(0, 200)
    );
  }

  return {
    connected: Boolean(p.connected ?? p.smartphoneConnected),
    session: p.session,
    raw,
  };
}

/** Roster COMPLETO do grupo — inclusive quem nunca falou. */
export async function getGroupMetadata(
  groupId: string
): Promise<{ participants: Array<{ phone: string; isAdmin?: boolean }> }> {
  const res = await fetchWithTimeout(
    `${instanceBase()}/group-metadata/${encodeURIComponent(groupId)}`,
    { method: "GET", headers: headers() },
    ZAPI_TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Z-API group-metadata ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { participants?: Array<{ phone: string; isAdmin?: boolean }> };
  return { participants: Array.isArray(data.participants) ? data.participants : [] };
}

// ── Inbound ──────────────────────────────────────────────────────────────

export type InboundKind = "text" | "image" | "audio" | "document" | "unknown";

export interface InboundMessage {
  messageId: string;
  /** Quem falou, E.164 sem "+". Em grupo é o participante, não o grupo. */
  fromPhone: string;
  /** Preenchido só em grupo — o JID do grupo. */
  groupId: string | null;
  kind: InboundKind;
  text: string | null;
  mediaUrl: string | null;
  mimeType: string | null;
  /** `momment` (sic) do provedor, em ms. */
  timestampMs: number | null;
  senderName: string | null;
  /** wamid citado, quando é resposta a outra mensagem. */
  replyToMessageId: string | null;
}

/**
 * Normaliza o webhook da Z-API. Devolve `null` para o que não deve virar turn:
 * eco das próprias mensagens (`fromMe`) e payload sem identificação.
 *
 * O eco é a armadilha clássica: com "notificar mensagens enviadas por mim"
 * ligado no painel, cada resposta do agente volta como mensagem nova e o bot
 * conversa sozinho até o rate limit.
 */
export function parseInbound(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;

  /**
   * A MESMA URL pode receber outros callbacks da Z-API (status de entrega,
   * presença, conexão) se alguém apontar os campos errados no painel. Eles têm
   * `phone` e `messageId` e passariam pelo resto do parse — virando um turn de
   * LLM pago sobre um evento que não é mensagem. Só `ReceivedCallback` (ou
   * payload sem `type`, formato antigo de teste) segue.
   */
  if (typeof p.type === "string" && p.type !== "ReceivedCallback") return null;

  if (p.fromMe === true) return null;

  // Reação (👍 numa mensagem) e sticker não são turn: responder a uma reação
  // é ruído, e sticker não tem conteúdo transcritível. Descartados antes da
  // fila — nem linha, nem modelo.
  if (p.reaction || p.sticker) return null;

  const messageId: string | undefined = p.messageId ?? p.id;
  const rawPhone: string | undefined = p.phone;
  if (!messageId || !rawPhone) return null;

  const isGroup = Boolean(p.isGroup) || isGroupJid(rawPhone);
  const groupId = isGroup ? rawPhone : null;
  // Em grupo o `phone` é do GRUPO; quem falou está em `participantPhone`.
  const fromPhone = isGroup ? (p.participantPhone ?? "") : rawPhone;
  if (!fromPhone) return null;

  let kind: InboundKind = "unknown";
  let text: string | null = null;
  let mediaUrl: string | null = null;
  let mimeType: string | null = null;

  if (p.text?.message !== undefined) {
    kind = "text";
    text = String(p.text.message ?? "");
  } else if (p.image) {
    kind = "image";
    mediaUrl = p.image.imageUrl ?? null;
    mimeType = p.image.mimeType ?? null;
    text = p.image.caption ?? null;
  } else if (p.audio) {
    kind = "audio";
    mediaUrl = p.audio.audioUrl ?? null;
    mimeType = p.audio.mimeType ?? null;
  } else if (p.document) {
    kind = "document";
    mediaUrl = p.document.documentUrl ?? null;
    mimeType = p.document.mimeType ?? null;
    text = p.document.caption ?? p.document.fileName ?? null;
  }

  return {
    messageId,
    fromPhone: String(fromPhone),
    groupId,
    kind,
    text,
    mediaUrl,
    mimeType,
    timestampMs: typeof p.momment === "number" ? p.momment : null,
    senderName: p.senderName ?? p.chatName ?? null,
    replyToMessageId: p.referenceMessageId ?? null,
  };
}

// ── Status de entrega ────────────────────────────────────────────────────

/**
 * Callback de status de mensagem ENVIADA (`MessageStatusCallback`): SENT,
 * RECEIVED (entregue), READ, PLAYED. É o único canal que distingue "a Z-API
 * aceitou" de "chegou no aparelho" — a reconciliação de entrega da Fase 4
 * consome isto. Parser separado do `parseInbound` de propósito: status não é
 * mensagem e nunca deve virar turn.
 */
export interface StatusCallback {
  /** SENT | RECEIVED | READ | PLAYED (como a Z-API mandar, sem normalizar). */
  status: string;
  /** Ids das mensagens a que o status se refere. */
  messageIds: string[];
  phone: string | null;
  momment: number | null;
}

export function parseStatusCallback(payload: unknown): StatusCallback | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  if (p.type !== "MessageStatusCallback") return null;
  if (typeof p.status !== "string" || !p.status) return null;

  const ids = (Array.isArray(p.ids) ? p.ids : [p.messageId])
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return null;

  return {
    status: p.status,
    messageIds: ids,
    phone: typeof p.phone === "string" ? p.phone : null,
    momment: typeof p.momment === "number" ? p.momment : null,
  };
}

/** A instância que assinou o webhook é a nossa? */
export function isExpectedInstance(payload: unknown): boolean {
  const expected = process.env.ZAPI_INSTANCE_ID;
  if (!expected) return false;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { instanceId?: string };
  return typeof p.instanceId === "string" && p.instanceId === expected;
}
