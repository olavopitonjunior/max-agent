import { createHash } from "node:crypto";
import { NEWTON_SYNTHETIC_PREFIX } from "./adapters/newton-bridge";

/**
 * Id da mensagem que chega pelo bridge do Newton, que não repassa o da Z-API.
 * Determinístico em (telefone, grupo, texto, nº de anexos, minuto): a
 * reentrega no mesmo minuto bate no `ON CONFLICT (message_id)` da fila.
 */
export function idSintetico(p: {
  phone: string;
  groupId: string | null;
  text: string;
  anexos: number;
  agoraMs: number;
}): string {
  const minuto = Math.floor(p.agoraMs / 60_000);
  const h = createHash("sha256")
    .update([p.phone, p.groupId ?? "", p.text, String(p.anexos), String(minuto)].join("\u0000"))
    .digest("hex");
  return `${NEWTON_SYNTHETIC_PREFIX}${h.slice(0, 40)}`;
}
