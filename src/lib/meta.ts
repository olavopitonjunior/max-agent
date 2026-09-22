/**
 * Cliente da WhatsApp Cloud API (Meta) — o canal oficial do Max a partir de
 * 2026-09, no WABA da FINCasa.
 *
 * Ponto de partida: `whatsapp-newton-bridge/src/lib/meta-cloud.ts`. Diferenças
 * deliberadas, cada uma um defeito encontrado lá:
 *
 *  - assinatura do webhook FAIL-CLOSED: sem `META_APP_SECRET` o POST é
 *    recusado (lá aceitava tudo, "DEV ONLY");
 *  - env lida por CHAMADA, não no carregamento do módulo — trocar a env na
 *    Vercel vale sem depender de cold start, e os testes conseguem stubar;
 *  - todo `fetch` passa por `fetchWithTimeout` (regra do serviço);
 *  - `statuses[]` é lido (lá era ignorado) — é a reconciliação de entrega;
 *  - erro não-2xx vira `MetaHttpError` com o código da Meta, e é o código que
 *    decide entre "canal inoperante" e "problema desta mensagem"
 *    (`transport/erro.ts`).
 *
 * O que muda em relação à Z-API, e que o resto do serviço precisa saber:
 *
 *  - **janela de 24h**: texto livre só sai até 24h depois da última mensagem
 *    da pessoa; fora dela, só template aprovado (erro 131047);
 *  - mídia chega como ID, não como URL pública: o download é autenticado e em
 *    dois passos (`GET /{media-id}` → URL temporária → `GET` com o token);
 *  - não existe "desemparelhada": o número está registrado ou não, e a saúde
 *    se lê em `GET /{phone-number-id}` (`status`, `quality_rating`);
 *  - não há grupos (o Max já os descartava).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchWithTimeout, META_TIMEOUT_MS } from "./http";
import { classificarMeta, MetaHttpError } from "./transport/erro";
import type {
  ConnectionState,
  InboundKind,
  InboundMessage,
  StatusCallback,
} from "./transport/types";

/**
 * Versão da Graph API. Fixada no código para que uma versão nova da Meta não
 * mude o comportamento sem PR; `META_GRAPH_VERSION` existe para antecipar a
 * troca quando a Meta aposentar esta.
 */
const GRAPH_VERSION_PADRAO = "v24.0";

function graphBase(): string {
  const v = (process.env.META_GRAPH_VERSION ?? "").trim() || GRAPH_VERSION_PADRAO;
  return `https://graph.facebook.com/${v}`;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} não configurada`);
  return v;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env("META_ACCESS_TOKEN")}`,
    "Content-Type": "application/json",
  };
}

async function graph<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(
    `${graphBase()}${path}`,
    { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } },
    META_TIMEOUT_MS
  );
  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    throw new MetaHttpError(path, res.status, corpo);
  }
  return (await res.json().catch(() => ({}))) as T;
}

// ── Envio ────────────────────────────────────────────────────────────────

interface MetaSendResponse {
  messages?: Array<{ id?: string }>;
}

/** Teto de corpo de texto da Cloud API. */
const MAX_TEXT_CHARS = 4096;

export async function sendText(params: {
  to: string;
  body: string;
  quoteMessageId?: string;
}): Promise<{ messageId: string | null }> {
  const res = await graph<MetaSendResponse>(`/${env("META_PHONE_NUMBER_ID")}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      // Sem preview: o link do formulário é o mesmo em toda notificação, e a
      // prévia gigante empurra o texto para fora da tela do celular.
      text: { body: params.body.slice(0, MAX_TEXT_CHARS), preview_url: false },
      ...(params.quoteMessageId ? { context: { message_id: params.quoteMessageId } } : {}),
    }),
  });
  return { messageId: res.messages?.[0]?.id ?? null };
}

// ── Mídia ────────────────────────────────────────────────────────────────

/**
 * Prefixo do `mediaUrl` produzido por esta porta. O `InboundMessage` guarda a
 * mídia como referência opaca; com o prefixo, uma linha antiga da Z-API (URL
 * pública) nunca é confundida com um ID da Meta depois do cutover.
 */
export const META_MEDIA_PREFIX = "meta:";

/** Mesmo teto da Z-API — amarrado ao limite do transcribe do ImobPro. */
export const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

export async function downloadMedia(
  ref: string
): Promise<{ data: Buffer; contentType: string | null } | null> {
  if (!ref.startsWith(META_MEDIA_PREFIX)) {
    console.warn("[meta] referência de mídia que não é da Meta — ignorada");
    return null;
  }
  const mediaId = ref.slice(META_MEDIA_PREFIX.length);
  try {
    const info = await graph<{ url?: string; file_size?: number; mime_type?: string }>(
      `/${encodeURIComponent(mediaId)}`,
      { method: "GET" }
    );
    if (!info.url) {
      console.warn("[meta] mídia sem URL na resposta");
      return null;
    }
    if (typeof info.file_size === "number" && info.file_size > MAX_MEDIA_BYTES) {
      console.warn(`[meta] mídia grande demais (${info.file_size} bytes) — ignorada`);
      return null;
    }

    // A URL temporária também exige o token — sem ele a Meta devolve 401.
    const res = await fetchWithTimeout(
      info.url,
      { headers: { Authorization: `Bearer ${env("META_ACCESS_TOKEN")}` } },
      META_TIMEOUT_MS
    );
    if (!res.ok) {
      console.warn(`[meta] download de mídia ${res.status}`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) {
      console.warn(`[meta] mídia fora do limite (${data.byteLength} bytes)`);
      return null;
    }
    return { data, contentType: res.headers.get("content-type") ?? info.mime_type ?? null };
  } catch (err) {
    console.error(
      "[meta] download de mídia falhou:",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── Saúde do número ──────────────────────────────────────────────────────

interface PhoneNumberInfo {
  status?: string;
  quality_rating?: string;
  code_verification_status?: string;
  messaging_limit_tier?: string;
}

/**
 * Estado do número, na mesma forma tri-estado da Z-API — o outbox, o inbound e
 * a F7 não precisam saber de onde veio:
 *
 *  · `connected: true` — `status` CONNECTED: pode enviar. A qualidade vai em
 *    `raw` para o painel; VERMELHA ainda envia e NÃO derruba o canal (seria
 *    represar a fila por um aviso);
 *  · `connected: false` COM `inoperante` — token recusado, pagamento, ou o
 *    número fora do ar (`status` diferente de CONNECTED, ou erro de conta);
 *  · LANÇA para o que não se reconhece (5xx, timeout, corpo sem `status`):
 *    "não consegui perguntar", tratado em fail-open pelos chamadores e contado
 *    como passada cega pela F7.
 */
export async function connectionStatus(): Promise<ConnectionState> {
  const path = `/${env("META_PHONE_NUMBER_ID")}?fields=status,quality_rating,code_verification_status,messaging_limit_tier`;
  let info: PhoneNumberInfo;
  try {
    info = await graph<PhoneNumberInfo>(path, { method: "GET" });
  } catch (err) {
    if (err instanceof MetaHttpError) {
      const motivo = classificarMeta(err.code);
      if (motivo) {
        return {
          connected: false,
          raw: { status: err.status, code: err.code },
          inoperante: { motivo, detalhe: err.message.slice(0, 300) },
        };
      }
    }
    throw err;
  }

  if (typeof info.status !== "string") {
    throw new Error(
      `Meta phone number sem campo status — formato inesperado: ${JSON.stringify(info).slice(0, 200)}`
    );
  }

  if (info.status.toUpperCase() === "CONNECTED") {
    return { connected: true, raw: info };
  }
  return {
    connected: false,
    raw: info,
    inoperante: {
      motivo: "numero",
      detalhe: `número com status ${info.status} (qualidade ${info.quality_rating ?? "?"})`,
    },
  };
}

// ── Webhook ──────────────────────────────────────────────────────────────

/**
 * `X-Hub-Signature-256` = `sha256=<hex>` do HMAC do CORPO CRU com o app
 * secret. Fail-closed: sem secret configurado, nada passa.
 */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error("[meta] META_APP_SECRET ausente — webhook recusado");
    return false;
  }
  if (!header || !header.startsWith("sha256=")) return false;
  const recebido = Buffer.from(header.slice("sha256=".length), "hex");
  const esperado = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

/**
 * Handshake de assinatura do webhook: a Meta faz GET com `hub.mode=subscribe`,
 * `hub.verify_token` e `hub.challenge`, e espera o challenge de volta.
 * Devolve o challenge quando o token confere; `null` caso contrário.
 */
export function verifyChallenge(params: URLSearchParams): string | null {
  const esperado = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!esperado) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const token = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("hub.challenge");
}

/**
 * Celular BR que chega sem o 9º dígito (`55` + DDD + 8 dígitos começando em
 * 6–9) ganha o 9. O `wa_id` da Meta preserva o formato antigo para contas
 * antigas, e o ImobPro guarda telefone de corretor COM o 9: sem isto, a mesma
 * pessoa não é reconhecida e abre uma conversa paralela. Fixo (2–5) não muda.
 */
export function canonicalizarWaId(waId: string): string {
  const d = waId.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4])) {
    return `${d.slice(0, 4)}9${d.slice(4)}`;
  }
  return d;
}

export interface MetaWebhookEvents {
  /** `metadata.phone_number_id` de cada change, para conferir que é o nosso. */
  phoneNumberIds: string[];
  messages: InboundMessage[];
  statuses: StatusCallback[];
  /** Falhas de envio vindas em `statuses[].errors`, por wamid. */
  failures: Array<{ messageId: string; code: number | null; title: string | null }>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Lê o webhook de `messages` da Cloud API. Tudo que não é mensagem de pessoa
 * nem status é ignorado aqui — o mesmo POST pode trazer outros campos
 * assinados no app (templates, qualidade), tratados à parte.
 */
export function parseWebhook(payload: unknown): MetaWebhookEvents {
  const out: MetaWebhookEvents = { phoneNumberIds: [], messages: [], statuses: [], failures: [] };
  if (!isRec(payload) || payload.object !== "whatsapp_business_account") return out;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    if (!isRec(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRec(change) || change.field !== "messages" || !isRec(change.value)) continue;
      const value = change.value;

      const pnid = isRec(value.metadata) ? str(value.metadata.phone_number_id) : null;
      if (pnid && !out.phoneNumberIds.includes(pnid)) out.phoneNumberIds.push(pnid);

      const nomes = new Map<string, string>();
      for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
        if (!isRec(c)) continue;
        const wa = str(c.wa_id);
        const nome = isRec(c.profile) ? str(c.profile.name) : null;
        if (wa && nome) nomes.set(wa, nome);
      }

      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        const msg = lerMensagem(m, nomes);
        if (msg) out.messages.push(msg);
      }

      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!isRec(s)) continue;
        const id = str(s.id);
        const status = str(s.status);
        if (!id || !status) continue;
        const ts = Number(s.timestamp);
        out.statuses.push({
          status,
          messageIds: [id],
          phone: str(s.recipient_id),
          momment: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null,
        });
        if (status === "failed") {
          const e = Array.isArray(s.errors) && isRec(s.errors[0]) ? s.errors[0] : null;
          out.failures.push({
            messageId: id,
            code: e && typeof e.code === "number" ? e.code : null,
            title: e ? str(e.title) : null,
          });
        }
      }
    }
  }
  return out;
}

function lerMensagem(m: unknown, nomes: Map<string, string>): InboundMessage | null {
  if (!isRec(m)) return null;
  const messageId = str(m.id);
  const from = str(m.from);
  const type = str(m.type);
  if (!messageId || !from || !type) return null;
  // Grupo (Cloud API Groups) e reação/sticker não viram turn — mesma regra da Z-API.
  if (m.group_id || type === "reaction" || type === "sticker") return null;

  let kind: InboundKind = "unknown";
  let text: string | null = null;
  let mediaUrl: string | null = null;
  let mimeType: string | null = null;

  const media = (k: string): Rec | null => (isRec(m[k]) ? (m[k] as Rec) : null);

  if (type === "text" && isRec(m.text)) {
    kind = "text";
    text = typeof m.text.body === "string" ? m.text.body : "";
  } else if (type === "image" && media("image")) {
    const i = media("image")!;
    kind = "image";
    mediaUrl = str(i.id) ? `${META_MEDIA_PREFIX}${i.id}` : null;
    mimeType = str(i.mime_type);
    text = str(i.caption);
  } else if (type === "audio" && media("audio")) {
    const a = media("audio")!;
    kind = "audio";
    mediaUrl = str(a.id) ? `${META_MEDIA_PREFIX}${a.id}` : null;
    mimeType = str(a.mime_type);
  } else if (type === "document" && media("document")) {
    const d = media("document")!;
    kind = "document";
    mediaUrl = str(d.id) ? `${META_MEDIA_PREFIX}${d.id}` : null;
    mimeType = str(d.mime_type);
    text = str(d.caption) ?? str(d.filename);
  } else if (type === "button" && isRec(m.button)) {
    // Toque num botão de resposta rápida de template: é uma resposta de texto.
    kind = "text";
    text = str(m.button.text) ?? "";
  } else if (type === "interactive" && isRec(m.interactive)) {
    const r = isRec(m.interactive.button_reply)
      ? m.interactive.button_reply
      : isRec(m.interactive.list_reply)
        ? m.interactive.list_reply
        : null;
    kind = "text";
    text = r ? (str(r.title) ?? "") : "";
  }

  const ts = Number(m.timestamp);
  const ctx = isRec(m.context) ? str(m.context.id) : null;

  return {
    messageId,
    fromPhone: canonicalizarWaId(from),
    groupId: null,
    kind,
    text,
    mediaUrl,
    mimeType,
    timestampMs: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null,
    senderName: nomes.get(from) ?? null,
    replyToMessageId: ctx,
  };
}

/** O webhook é do nosso número? (O mesmo app pode servir mais de um.) */
export function isExpectedPhoneNumber(ids: string[]): boolean {
  const esperado = process.env.META_PHONE_NUMBER_ID;
  return !!esperado && ids.length > 0 && ids.every((id) => id === esperado);
}
