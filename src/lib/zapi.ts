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
  const res = await fetch(`${instanceBase()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
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
 * Estado da instância. É o ÚNICO jeito de saber se as mensagens estão mesmo
 * saindo: desemparelhada, a Z-API aceita o `send-text` com 200 e um
 * `messageId` que nunca chega a lugar nenhum.
 */
export async function connectionStatus(): Promise<{
  connected: boolean;
  session?: string;
  raw: unknown;
}> {
  const res = await fetch(`${instanceBase()}/status`, {
    method: "GET",
    headers: headers(),
  });
  const raw = await res.json().catch(() => null);
  const p = (raw ?? {}) as { connected?: boolean; smartphoneConnected?: boolean; session?: string };
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
  const res = await fetch(
    `${instanceBase()}/group-metadata/${encodeURIComponent(groupId)}`,
    { method: "GET", headers: headers() }
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

  if (p.fromMe === true) return null;

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

/** A instância que assinou o webhook é a nossa? */
export function isExpectedInstance(payload: unknown): boolean {
  const expected = process.env.ZAPI_INSTANCE_ID;
  if (!expected) return false;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { instanceId?: string };
  return typeof p.instanceId === "string" && p.instanceId === expected;
}
