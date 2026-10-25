import { randomUUID } from "node:crypto";
import { log } from "../../log";
import type { TransportAdapter } from "../types";

/**
 * Transporte sem rede, para staging e homologação de um deploy sem número
 * real (o playground nem chega aqui: `sendText` o barra antes). A linha da outbox vira
 * `sent` e o log guarda só destino e tamanho, nunca o texto. Recusado em
 * produção por `adapter()`.
 */
export const logAdapter: TransportAdapter = {
  name: "log",
  capabilities: { templates: false, window24h: false, media: false, groups: false, status: false, typing: false, interactive: false },
  async sendText({ to, body }) {
    log.info("transport.log", { to, chars: body.length });
    return { messageId: `log-${randomUUID()}` };
  },
  async connectionStatus() {
    return { connected: true, raw: { adapter: "log" } };
  },
  async downloadMedia() {
    return null;
  },
};
