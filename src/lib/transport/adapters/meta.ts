import * as meta from "../../meta";
import type { DownloadMediaFn, OpcoesDeDownload, TransportAdapter } from "../types";

/**
 * Cloud API da Meta: o código de sempre, só atrás da interface. Chama pelo
 * namespace em cada envio para que `vi.mock("../meta")` continue valendo.
 */
export const metaAdapter: TransportAdapter = {
  name: "meta",
  capabilities: { templates: true, window24h: true, media: true, groups: false, status: true, typing: true, interactive: true, reactions: true },
  sendText: (params) => meta.sendText(params),
  sendTemplate: (params) => meta.sendTemplate(params),
  sendInteractive: (params) => meta.sendInteractive(params),
  sendReaction: (params) => meta.sendReaction(params),
  markReadTyping: (messageId) => meta.markReadTyping(messageId),
  connectionStatus: () => meta.connectionStatus(),
  // Sem `opts` chama com UM argumento (os mocks e os chamadores antigos veem a chamada de sempre).
  downloadMedia: ((ref: string, opts?: OpcoesDeDownload) =>
    opts ? meta.downloadMedia(ref, opts) : meta.downloadMedia(ref)) as DownloadMediaFn,
};
