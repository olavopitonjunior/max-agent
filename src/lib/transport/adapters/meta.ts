import * as meta from "../../meta";
import type { TransportAdapter } from "../types";

/**
 * Cloud API da Meta: o código de sempre, só atrás da interface. Chama pelo
 * namespace em cada envio para que `vi.mock("../meta")` continue valendo.
 */
export const metaAdapter: TransportAdapter = {
  name: "meta",
  capabilities: { templates: true, window24h: true, media: true, groups: false, status: true },
  sendText: (params) => meta.sendText(params),
  sendTemplate: (params) => meta.sendTemplate(params),
  connectionStatus: () => meta.connectionStatus(),
  downloadMedia: (ref) => meta.downloadMedia(ref),
};
