import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { destinoPermitido, ehIdDeOutbox } from "@/lib/redirect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /r/<id> — o destino do botão "Abrir no ImobPro" dos templates da Meta.
 *
 * ── Por que existe ───────────────────────────────────────────────────────
 * O botão de URL de um template só aceita DOMÍNIO FIXO com a variável no fim
 * (`https://dominio/r/{{1}}`), e o link real de uma notificação muda de host
 * por tenant (subdomínio por imobiliária). Então o botão aponta para cá com o
 * id da linha do outbox, e esta rota devolve 302 para o `link_url` gravado.
 * De quebra, o primeiro clique fica registrado (`clicked_at`).
 *
 * ── Por que é pública e ainda assim segura ───────────────────────────────
 *  · O id é o UUID aleatório da linha do outbox — não enumerável.
 *  · O destino vem do BANCO, nunca da URL: não há parâmetro que alguém possa
 *    trocar para mandar o clique para outro lugar (open redirect).
 *  · Mesmo assim o destino é conferido pelo `hostname` parseado — só
 *    `imobpro.ia.br` e subdomínios, só http(s), sem usuário/senha nem porta.
 *    Um `link_url` fora disso (dado ruim ou comprometido) vira 404, não 302.
 *  · O destino exige login no ImobPro: saber o link não dá acesso a nada.
 *
 * Fora de `/api` de propósito: a URL aparece no botão, então quanto mais
 * curta, melhor — e nenhuma autenticação de `/api` se aplica aqui.
 */

const naoEncontrado = () => new NextResponse("link não encontrado", { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!ehIdDeOutbox(params.id)) return naoEncontrado();

  const rows = await query<{ link_url: string | null }>(
    `SELECT link_url FROM outbox WHERE id = $1`,
    [params.id]
  );
  const destino = destinoPermitido(rows[0]?.link_url);
  if (!destino) return naoEncontrado();

  // Primeiro clique só: COALESCE mantém o carimbo original. Melhor-esforço —
  // o clique não pode falhar por causa da métrica.
  await query(`UPDATE outbox SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [
    params.id,
  ]).catch((err) =>
    console.warn("[r] clique não registrado:", err instanceof Error ? err.message : String(err))
  );

  return NextResponse.redirect(destino.toString(), 302);
}
