import { fetchWithTimeout, NEWTON_BRIDGE_TIMEOUT_MS } from "../../http";
import type { TransportAdapter } from "../types";

/**
 * Bridge do Newton (`whatsapp-newton-bridge`, Z-API no número da Newcore).
 * O motor não fala com a Z-API: entrega o texto ao bridge, que é quem tem a
 * instância. Contrato do bridge (`src/app/api/send/route.ts`): `POST /api/send`
 * com `Bearer BRIDGE_INTERNAL_TOKEN`, corpo `{to, body, context?}`, resposta
 * `{provider, messageId, raw}`.
 *
 * Sem template e sem janela de 24h: a Z-API manda texto livre sempre. Sem
 * mídia e sem status por enquanto — o bridge descarta os callbacks de status
 * (fase 4.2 do plano).
 */

/** Teto do bridge (ele mesmo corta em 4096 antes de mandar). */
const MAX_TEXT_CHARS = 4096;

/** O que o bridge aceita em `to`: DM em dígitos ou grupo `<id>-group`. */
const DESTINO = /^(\d{10,15}|\d{10,25}-group)$/;

/**
 * Prefixo dos ids que a rota `/api/agents/newton/run` sintetiza (o bridge não
 * repassa o id da Z-API). Não existem na Z-API: citá-los faria o envio falhar.
 */
export const NEWTON_SYNTHETIC_PREFIX = "newton:";

function config(): { url: string; token: string } {
  const url = (process.env.NEWTON_BRIDGE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.NEWTON_BRIDGE_TOKEN ?? "").trim();
  if (!url || !token) throw new Error("newton_bridge_nao_configurado");
  return { url, token };
}

export const newtonBridgeAdapter: TransportAdapter = {
  name: "newton-bridge",
  capabilities: { templates: false, window24h: false, media: false, groups: true, status: false, typing: false },
  async sendText({ to, body, quoteMessageId }) {
    if (!DESTINO.test(to)) throw new Error("newton_bridge_destino_invalido");
    const { url, token } = config();
    const citar = !!quoteMessageId && !quoteMessageId.startsWith(NEWTON_SYNTHETIC_PREFIX);
    const res = await fetchWithTimeout(
      `${url}/api/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          body: body.slice(0, MAX_TEXT_CHARS),
          ...(citar ? { context: { message_id: quoteMessageId } } : {}),
        }),
      },
      NEWTON_BRIDGE_TIMEOUT_MS
    );
    if (!res.ok) {
      // Só o status: o `error` do bridge pode ecoar o corpo da Z-API.
      throw new Error(`newton_bridge_http_${res.status}`);
    }
    const json = (await res.json().catch(() => ({}))) as { messageId?: unknown };
    return { messageId: typeof json.messageId === "string" && json.messageId ? json.messageId : null };
  },
  /**
   * O bridge não expõe o estado da instância. Falha aberta, como o
   * `podeResponder` do inbound: não saber não é estar desconectado.
   */
  async connectionStatus() {
    return { connected: true, raw: { adapter: "newton-bridge" } };
  },
  async downloadMedia() {
    return null;
  },
};
