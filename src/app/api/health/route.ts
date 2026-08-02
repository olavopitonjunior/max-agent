import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness. Não toca banco nem Z-API — health que depende de tudo mente. */
export function GET() {
  return NextResponse.json({ ok: true, service: "max-agent" });
}
