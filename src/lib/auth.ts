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
 * A tolerância ao formato antigo (`timestamp.""`) FOI REMOVIDA em 2026-08-28
 * (max#21). O sunset não se apoiou no log — a retenção de runtime log do plano
 * é de 1 dia e o `/admin/status` só é chamado quando alguém abre o painel, então
 * "log zerado" media apenas que ninguém tinha olhado a tela. A prova foi
 * estática: o ÚNICO chamador da rota é `getMaxStatus`
 * (`contractmaker/apps/web/src/lib/max/admin-client.ts`), e ele assina
 * `GET.${pathname}${search}` via `signMaxAdminRequest`. Nenhum outro repo da
 * conta chama. A tolerância era código morto — e enquanto viva, mantinha aberto
 * o replay cross-tenant que a assinatura com query fechou.
 */
export async function requireHmac(
  req: NextRequest,
  opts: { signQuery?: boolean } = {}
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
  if (!verdict.ok && verdict.reason === "bad_signature" && opts.signQuery) {
    // Segunda forma aceita: a MESMA query, normalizada. Ver `queryCanonica`.
    const canonico = `${req.method}.${req.nextUrl.pathname}${queryCanonica(req.nextUrl.search)}`;
    if (canonico !== signedPayload) {
      verdict = verifySignature({ timestamp, signature, rawBody: canonico, secret });
      // Sem valores: só para saber qual grafia chega em produção.
      if (verdict.ok) console.info(`[auth] aceita pela query canônica em ${req.nextUrl.pathname}`);
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

/**
 * A query como o ImobPro a assina: `URLSearchParams.toString()` (o cliente monta
 * a URL com `url.searchParams.set` e assina `url.search`).
 *
 * Os bytes que chegam aqui nem sempre são os que saíram de lá: entre o fetch e
 * o handler, `%28sem+org%29` pode virar `(sem+org)` ou `+` virar `%20`. Era o
 * que dava 401 só nas conversas sem imobiliária (`orgId=(sem org)`), no cursor
 * que carrega esse rótulo e na busca com parêntese (05/10/2026). Decodificar e
 * reserializar devolve a forma assinada sem aceitar NADA além dela: os pares
 * chave/valor são os mesmos, só a grafia muda.
 */
export function queryCanonica(search: string): string {
  const s = new URLSearchParams(search).toString();
  return s ? `?${s}` : "";
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

/**
 * Gate das rotas de webhook da Z-API (mensagens e status): segredo no PATH.
 *
 * Num lugar só pelo mesmo motivo do HMAC acima — a checagem existia copiada
 * nas duas rotas (quatro contando os GET), e um conserto futuro (rotação com
 * dois valores aceitos, rate limit de sondagem) esqueceria uma cópia.
 *
 * Sem env → 500, nunca 200 silencioso (deploy sem env descartaria tudo
 * parecendo saudável). Segredo errado → 404: para quem sonda a URL, o
 * endpoint não deve nem existir.
 */
export function requireZapiSecret(paramSecret: string): NextResponse | null {
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[auth] ZAPI_WEBHOOK_SECRET não configurada");
    return NextResponse.json({ error: "not_configured" }, { status: 500 });
  }
  if (paramSecret !== expected) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return null;
}
