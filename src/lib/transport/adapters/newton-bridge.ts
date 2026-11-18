import { fetchWithTimeout, NEWTON_BRIDGE_TIMEOUT_MS, NEWTON_MEDIA_TIMEOUT_MS } from "../../http";
import { MAX_MEDIA_BYTES } from "../../meta";
import { sniffMime, urlDeMidiaPermitida, ZAPI_MEDIA_PREFIX } from "../newton-media";
import type { DownloadMediaFn, MidiaBaixada, MidiaGrandeDemais, OpcoesDeDownload, TransportAdapter } from "../types";

/**
 * Bridge do Newton (`whatsapp-newton-bridge`, Z-API no número da Newcore).
 * O motor não fala com a Z-API: entrega o texto ao bridge, que é quem tem a
 * instância. Contrato do bridge (`src/app/api/send/route.ts`): `POST /api/send`
 * com `Bearer BRIDGE_INTERNAL_TOKEN`, corpo `{to, body, context?}`, resposta
 * `{provider, messageId, raw}`.
 *
 * Sem template e sem janela de 24h: a Z-API manda texto livre sempre. Sem
 * envio de mídia e sem status por enquanto — o bridge descarta os callbacks de
 * status (fase 4.2 do plano). A mídia que CHEGA é outra coisa: o bridge repassa
 * a URL da Z-API (`zapi:<url>` na fila) e `downloadMedia` baixa daqui.
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
  capabilities: { templates: false, window24h: false, media: false, groups: true, status: false, typing: false, interactive: false, reactions: false },
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
  downloadMedia: ((ref: string, opts?: OpcoesDeDownload) =>
    baixarMidiaZapi(ref, opts?.distinguirTamanho === true)) as DownloadMediaFn,
};

/**
 * Baixa a mídia que o bridge repassou por URL. A URL vem num corpo e é link não
 * adivinhável para documento de cliente, então: só `https` e host da allowlist
 * (`urlDeMidiaPermitida`), sem seguir redirect, sem credencial no pedido, teto
 * de `MAX_MEDIA_BYTES` conferido no cabeçalho e nos bytes lidos, e o tipo vale o
 * dos bytes (`sniffMime`). Todo tropeço devolve `null` (o grafo trata mídia que
 * não leu) e o log traz só o host e o motivo — nunca a URL nem a mensagem do
 * erro, que o wrapper de timeout monta com o caminho.
 */
async function baixarMidiaZapi(
  ref: string,
  distinguirTamanho = false
): Promise<MidiaBaixada | MidiaGrandeDemais | null> {
  if (!ref.startsWith(ZAPI_MEDIA_PREFIX)) return null;
  const url = urlDeMidiaPermitida(ref.slice(ZAPI_MEDIA_PREFIX.length));
  if (!url) {
    console.warn("[newton-bridge] mídia recusada: motivo=host");
    return null;
  }
  const recusar = (motivo: string): null => {
    console.warn(`[newton-bridge] mídia não baixada: host=${url.host} motivo=${motivo}`);
    return null;
  };
  // Passou do teto: o motivo "tamanho" só sai como valor quando o chamador pediu; vazio segue null.
  const grande = (): MidiaGrandeDemais | null => {
    recusar("tamanho");
    return distinguirTamanho ? { erro: "tamanho" } : null;
  };
  try {
    const res = await fetchWithTimeout(url.href, { method: "GET", redirect: "manual", headers: {} }, NEWTON_MEDIA_TIMEOUT_MS);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return recusar(`http_${res.status}`);
    }
    const declarado = Number(res.headers.get("content-length"));
    if (Number.isFinite(declarado) && declarado > MAX_MEDIA_BYTES) {
      await res.body?.cancel().catch(() => {});
      return grande();
    }
    const data = await lerAteOTeto(res);
    if (!data) return grande();
    if (data.byteLength === 0) return recusar("vazio");
    const tipo = sniffMime(data);
    if (!tipo) return recusar("tipo");
    return { data, contentType: tipo };
  } catch {
    return recusar("erro");
  }
}

/** Lê o corpo em pedaços e desiste ao passar do teto, sem materializar o excedente. `null` = passou. */
async function lerAteOTeto(res: Response): Promise<Buffer | null> {
  if (!res.body) {
    const data = Buffer.from(await res.arrayBuffer());
    return data.byteLength > MAX_MEDIA_BYTES ? null : data;
  }
  const reader = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    partes.push(value);
  }
  return Buffer.concat(partes, total);
}
