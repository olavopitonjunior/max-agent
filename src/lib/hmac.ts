import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Autenticação do `/notify` — o canal por onde o ImobPro entrega notificações
 * ao Max.
 *
 * A assinatura cobre `${timestamp}.${rawBody}`, e não só o corpo: sem o
 * timestamp dentro do que é assinado, quem capturasse uma requisição poderia
 * reenviá-la para sempre com a mesma assinatura válida. Com ele, a validade
 * expira junto com a janela abaixo.
 *
 * Espelha `apps/web/src/lib/max/notify-trigger.ts::sign` do Contractmaker. Se
 * um dos dois lados mudar o que entra no HMAC, TODA notificação passa a ser
 * recusada — os testes dos dois repos fixam o formato de propósito.
 */

/**
 * Tolerância de relógio. Cinco minutos cobre desvio de NTP entre a Vercel e
 * aqui com folga, e é curto o bastante para que uma requisição capturada
 * envelheça antes de servir para muita coisa.
 */
export const MAX_SKEW_MS = 5 * 60_000;

export function sign(
  timestamp: string,
  rawBody: string,
  secret: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "bad_timestamp" | "expired" | "bad_signature" };

/**
 * `now` é injetável só para os testes conseguirem exercitar a expiração sem
 * mexer no relógio do processo.
 */
export function verifySignature(params: {
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret: string;
  now?: number;
}): VerifyResult {
  const { timestamp, signature, rawBody, secret } = params;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };

  const now = params.now ?? Date.now();
  // Abs: um timestamp no FUTURO é tão suspeito quanto um velho demais — seria
  // uma requisição forjada com relógio adiantado para durar mais.
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "expired" };

  const expected = sign(timestamp, rawBody, secret);

  // Comparação em tempo constante. `timingSafeEqual` exige buffers do mesmo
  // tamanho, e assinatura de tamanho errado é rejeitada antes — comparar o
  // comprimento não vaza nada útil, já que ele é público (sha256 hex = 64).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  return { ok: true };
}
