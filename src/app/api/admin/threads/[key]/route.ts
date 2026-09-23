import { NextRequest, NextResponse } from "next/server";
import { requireHmac } from "@/lib/auth";
import { maskPhone } from "@/lib/phone";
import { linhaDoTempo, resolverTelefone, type EventoLinhaDoTempo } from "@/lib/threads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/threads/<key>?orgId=… — a linha do tempo de UMA pessoa numa
 * org: o que ela disse, o que o Max respondeu (com tools, custo e entrega) e
 * os avisos que o sistema mandou (com template, status e erro da Meta).
 *
 * `orgId` é OBRIGATÓRIO aqui, sem `scope=all`: a thread é (org, telefone), e a
 * mesma pessoa em duas orgs são duas threads. O super-admin que vê a lista
 * geral já recebe o `orgId` de cada linha.
 *
 * `<key>` é o `phoneTag` que a lista devolveu. Tag que não existe nesta org
 * responde 404 IGUAL ao de tag que não existe em lugar nenhum: diferenciar
 * contaria ao admin de uma org que aquela pessoa conversa com outra.
 */

const MAX_LIMITE = 100;

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const auth = await requireHmac(req, { signQuery: true });
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const orgId = sp.get("orgId");
  if (!orgId) {
    return NextResponse.json({ error: "org_id_obrigatorio" }, { status: 400 });
  }

  const limiteBruto = Number(sp.get("limit") ?? 50);
  const limite = Number.isFinite(limiteBruto)
    ? Math.min(Math.max(Math.trunc(limiteBruto), 1), MAX_LIMITE)
    : 50;

  const cursorBruto = sp.get("cursor");
  let cursor: { ts: string; id: string } | null = null;
  if (cursorBruto) {
    const [ts, id, ...resto] = cursorBruto.split("|");
    if (resto.length || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(ts ?? "") || !id) {
      return NextResponse.json({ error: "cursor_invalido" }, { status: 400 });
    }
    cursor = { ts, id };
  }

  try {
    const phone = await resolverTelefone(orgId, params.key);
    if (!phone) {
      return NextResponse.json({ error: "thread_nao_encontrada" }, { status: 404 });
    }
    const eventos = await linhaDoTempo(orgId, phone, cursor, limite);
    const ultimo = eventos[eventos.length - 1];
    return NextResponse.json({
      key: params.key,
      orgId,
      phone: maskPhone(phone),
      eventos: eventos.map(formatar),
      nextCursor: eventos.length === limite && ultimo ? `${ultimo.em}|${ultimo.id}` : null,
    });
  } catch (err) {
    console.warn(
      "[admin/threads/key] leitura falhou:",
      err instanceof Error ? err.message : String(err)
    );
    if ((err as { code?: string }).code === "42P01") {
      return NextResponse.json({ error: "thread_nao_encontrada", degraded: "sem_tabela" }, { status: 404 });
    }
    throw err;
  }
}

/**
 * Um formato por origem, sem colunas nulas da outra. `tools` sai inteiro,
 * com args: quem decide mostrar ou não para o admin do tenant é o ImobPro,
 * que sabe quem está olhando.
 */
function formatar(e: EventoLinhaDoTempo) {
  if (e.origem === "turn") {
    return {
      origem: "turn" as const,
      id: e.id,
      em: e.em,
      messageId: e.message_id,
      kind: e.kind,
      inboundText: e.inbound_text,
      transcript: e.transcript,
      replyText: e.reply_text,
      tools: e.tools_json,
      usage: e.usage_json,
      latencyMs: e.latency_ms,
      error: semTelefone(e.error),
      entrega: {
        status: e.reply_delivery_status,
        deliveredAt: e.reply_delivered_at,
        readAt: e.reply_read_at,
      },
    };
  }
  return {
    origem: "aviso" as const,
    id: e.id,
    em: e.em,
    titulo: e.titulo,
    corpo: e.corpo,
    linkUrl: e.link_url,
    kind: e.aviso_kind,
    templateName: e.template_name,
    dealId: e.deal_id,
    status: e.status,
    entrega: {
      status: e.delivery_status,
      sentAt: e.sent_at,
      deliveredAt: e.delivered_at,
      readAt: e.read_at,
      clickedAt: e.clicked_at,
    },
    errorCode: e.error_code,
    lastError: semTelefone(e.last_error),
  };
}

/**
 * Mensagem de erro vem do provedor (`err.message`), e provedor costuma citar o
 * destinatário. Texto da conversa fica como está (é o conteúdo que o painel
 * existe para mostrar); o erro é metadado, e nele o número não tem função.
 */
function semTelefone(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  // Dígitos com separadores no meio: provedor formata ("55 11 98765-0003",
  // "(11) 98765-0003"). Casa o trecho largo e só mascara se, sem os
  // separadores, tiver cara de telefone (10 a 13 dígitos).
  return texto.replace(/\+?\(?\d[\d\s().-]{8,20}\d/g, (m) => {
    const digitos = m.replace(/\D/g, "");
    return digitos.length >= 10 && digitos.length <= 13 ? maskPhone(digitos) : m;
  });
}
