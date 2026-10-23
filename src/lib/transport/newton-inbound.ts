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

/**
 * O bridge sempre preenche `text` para mídia, com um marcador no lugar do
 * conteúdo (`whatsapp-newton-bridge`, rotas de webhook). Marcador sozinho não
 * é texto: sem isso o modelo acharia que recebeu o arquivo. Áudio transcrito
 * vira só a transcrição.
 */
const MARCADOR_SEM_CONTEUDO =
  /^\[(imagem enviada|documento: [^\]\n]*|áudio enviado — transcrição indisponível[^\]\n]*)\]$/;
const MARCADOR_AUDIO = /^\[áudio transcrito · [\d.]+KB\]\n/;

/**
 * Prefixos que o bridge põe antes do conteúdo, nesta ordem: o aviso do
 * `annotate` (sanitize.ts) e a marca de citação (`replyToMessageId` da Z-API,
 * id que o motor não conhece). Saem os dois: sobrando, "SIM" deixaria de ser
 * "SIM" para as interceptações determinísticas, e o marcador de mídia não
 * seria reconhecido.
 */
const PREFIXO_AVISO = /^\[suspicious instruction-like content detected · [^\]\n]*\]\n/;
const PREFIXO_CITACAO = /^\[respondendo a msg id=[^\]\n]*\] ?/;

export function textoDoBridge(bruto: string): string {
  const t = bruto.trim().replace(PREFIXO_AVISO, "").replace(PREFIXO_CITACAO, "").trim();
  if (MARCADOR_SEM_CONTEUDO.test(t)) return "";
  return t.replace(MARCADOR_AUDIO, "").trim();
}

/**
 * Id da Z-API, quando o bridge passar a mandá-lo (fase 4.2). Vale como está,
 * para que a resposta possa citar a mensagem; o prefixo sintético é recusado.
 */
export function idDoBridge(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(id) || id.startsWith(NEWTON_SYNTHETIC_PREFIX)) return null;
  return id;
}
