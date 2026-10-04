import { NextRequest, NextResponse } from "next/server";
import { requireHmac } from "@/lib/auth";
import { relatorioCustos } from "@/lib/custos/relatorio";
import { diaNoFuso } from "@/lib/custos/meta-analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DIAS = 400;

/**
 * GET /api/admin/costs?de=YYYY-MM-DD&ate=YYYY-MM-DD[&orgId=] — custo do
 * WhatsApp do Max para a aba Custos do `/admin/max` (só o admin geral vê).
 *
 * Mesma auth do `/api/admin/status`: a assinatura cobre método e path COM a
 * query, então uma assinatura capturada não serve para outro período nem para
 * outra imobiliária. Sem `de`/`ate`: o mês corrente até hoje, no fuso da WABA (São Paulo).
 */
export async function GET(req: NextRequest) {
  const auth = await requireHmac(req, { signQuery: true });
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  // "Hoje" e o mês corrente no fuso dos custos (o da Meta), não em UTC.
  const hoje = diaNoFuso(Date.now());
  const de = sp.get("de") ?? `${hoje.slice(0, 8)}01`;
  const ate = sp.get("ate") ?? hoje;
  const orgId = sp.get("orgId") || null;

  // Ida e volta: `2026-02-31` passa no `Date.parse` (vira março) e o Postgres
  // recusaria com 500 — aqui vira 400.
  const valido = (s: string) =>
    DIA.test(s) && !Number.isNaN(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  if (!valido(de) || !valido(ate)) {
    return NextResponse.json({ error: "periodo_invalido" }, { status: 400 });
  }
  const dias = (Date.parse(ate) - Date.parse(de)) / 86_400_000;
  if (dias < 0 || dias > MAX_DIAS) {
    return NextResponse.json({ error: "periodo_invalido" }, { status: 400 });
  }

  return NextResponse.json(await relatorioCustos({ de, ate, orgId }));
}
