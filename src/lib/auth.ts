import { NextRequest, NextResponse } from "next/server";
import { verifySignature } from "./hmac";

/**
 * Autenticação das rotas, num lugar só.
 *
 * O bloco HMAC (secret → rawBody → verifySignature → 401) existia copiado em
 * quatro rotas e o do Bearer dos crons em duas — código de segurança duplicado
 * é onde um conserto esquece uma cópia.
 */

export type AuthResult =
  | { ok: true; rawBody: string }
  | { ok: false; response: NextResponse };

/**
 * Verifica o HMAC de uma requisição assinada pelo ImobPro (ou por script do
 * dono). O payload assinado é `${timestamp}.${signedPayload}`:
 *
 *  - rotas com corpo (`/notify`, `/orgs`): `signedPayload` = corpo CRU, byte a
 *    byte — reserializar o JSON quebraria na primeira diferença de ordem de
 *    chave. Formato travado com o Contractmaker por vetor fixo
 *    (`hmac-parity.test.ts`); NÃO mudar de um lado só.
 *  - GET com query relevante (`/admin/status`): `signedPayload` =
 *    `${method}.${pathname}${search}`. Cobrir a query é o ponto — assinar só o
 *    corpo vazio deixava o `?orgId=` fora da assinatura, e uma assinatura
 *    capturada valia por 5 minutos para QUALQUER org (enumeração cross-tenant).
 *
 * `allowLegacyEmptyBody`: transição do `/admin/status` — o admin do
 * Contractmaker ainda assina o formato antigo (`timestamp.""`). Aceita os dois
 * até o cliente de lá migrar; derrubar o antigo é um flag a remover.
 */
export async function requireHmac(
  req: NextRequest,
  opts: { signQuery?: boolean; allowLegacyEmptyBody?: boolean } = {}
): Promise<AuthResult> {
  const secret = process.env.MAX_NOTIFY_SECRET;
  if (!secret) {
    console.error("[auth] MAX_NOTIFY_SECRET não configurada");
    return {
      ok: false,
      response: NextResponse.json({ error: "not_configured" }, { status: 500 }),
    };
  }

  const rawBody = opts.signQuery ? "" : await req.text();
  const signedPayload = opts.signQuery
    ? `${req.method}.${req.nextUrl.pathname}${req.nextUrl.search}`
    : rawBody;

  const timestamp = req.headers.get("x-max-timestamp");
  const signature = req.headers.get("x-max-signature");

  let verdict = verifySignature({ timestamp, signature, rawBody: signedPayload, secret });
  if (!verdict.ok && opts.signQuery && opts.allowLegacyEmptyBody) {
    verdict = verifySignature({ timestamp, signature, rawBody: "", secret });
    if (verdict.ok) {
      /**
       * TELEMETRIA DO SUNSET: enquanto este log aparecer, o cliente ainda
       * assina o formato antigo e o replay cross-tenant continua possível.
       * Quando a migração do Contractmaker entrar (issue #347 de lá) e este
       * log ZERAR por alguns dias, remova o `allowLegacyEmptyBody` — sem o
       * log, o flag viraria permanente e a correção, cerimônia.
       */
      console.warn(
        `[auth] assinatura LEGADA aceita em ${req.nextUrl.pathname} — ` +
          `migrar o cliente e remover allowLegacyEmptyBody (contractmaker#347)`
      );
    }
  }

  if (!verdict.ok) {
    // Sem detalhe no corpo: para quem não tem o segredo, "assinatura inválida"
    // e "timestamp velho" não devem ser distinguíveis.
    console.warn(`[auth] assinatura recusada em ${req.nextUrl.pathname}: ${verdict.reason}`);
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }

  return { ok: true, rawBody };
}

/** Auth dos crons: `Authorization: Bearer $CRON_SECRET`, mandado pela Vercel. */
export function requireCronSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[auth] CRON_SECRET não configurada");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
