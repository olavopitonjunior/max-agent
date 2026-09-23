import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `/api/admin/threads` e `/api/admin/threads/<key>` — a leitura de conversa que
 * o admin do TENANT vai usar (Fase 4), e não só o super-admin.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 *  · uma org não vê a outra, nem quando o MESMO telefone conversa com as duas
 *    (a thread é org+telefone; filtrar só a resolução da chave vazaria);
 *  · tag de outra org e tag inexistente dão o MESMO 404;
 *  · o telefone cru não sai em lugar nenhum da resposta;
 *  · a assinatura cobre `orgId`, `q` e `cursor`;
 *  · as paginações não perdem nem repetem linha.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

const { query, db } = await import("@/lib/db");
const { sign } = await import("@/lib/hmac");
const { phoneTag } = await import("@/lib/phone");

const SECRET = "s-threads";
const ORG_A = "org-threads-a";
const ORG_B = "org-threads-b";
const ORGS = [ORG_A, ORG_B];
// Formato de gravação (sem "+"), o mesmo de `conversationKey`/`toZapiPhone`.
const TEL_AMBAS = "5511987650001";
const TEL_SO_A = "5511987650002";
const TEL_SO_B = "5511987650003";
const TELS = [TEL_AMBAS, TEL_SO_A, TEL_SO_B];

function assinada(path: string, secret = SECRET) {
  const ts = String(Date.now());
  return new NextRequest(`http://max.test${path}`, {
    headers: {
      "x-max-timestamp": ts,
      "x-max-signature": sign(ts, `GET.${path}`, secret),
    },
  });
}

async function lista(qs: string) {
  const { GET } = await import("@/app/api/admin/threads/route");
  return GET(assinada(`/api/admin/threads${qs}`));
}

async function detalhe(key: string, qs: string) {
  const { GET } = await import("@/app/api/admin/threads/[key]/route");
  return GET(assinada(`/api/admin/threads/${key}${qs}`), { params: { key } });
}

let seq = 0;
async function turn(org: string, phone: string, p: {
  em?: string; texto?: string; resposta?: string; erro?: string; messageId?: string; tools?: unknown;
} = {}) {
  await query(
    `INSERT INTO conversation_turn
       (org_id, phone, message_id, inbound_text, reply_text, error, tools_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now()))`,
    [org, phone, p.messageId ?? null, p.texto ?? "oi", p.resposta ?? "olá",
     p.erro ?? null, JSON.stringify(p.tools ?? []), p.em ?? null]
  );
}

async function aviso(org: string, phone: string, p: {
  em?: string; nome?: string; status?: string; lastError?: string; errorCode?: number;
} = {}) {
  seq += 1;
  await query(
    `INSERT INTO outbox
       (id, org_id, dedupe_key, audience, phone, recipient_name, title, body,
        status, last_error, error_code, created_at)
     VALUES ($1,$2,$1,'broker',$3,$4,'Aviso','corpo',$5,$6,$7,COALESCE($8::timestamptz, now()))`,
    [`thr-${seq}-${Date.now()}`, org, phone, p.nome ?? "", p.status ?? "sent",
     p.lastError ?? null, p.errorCode ?? null, p.em ?? null]
  );
}

async function limpar() {
  await query(`DELETE FROM conversation_turn WHERE org_id = ANY($1)`, [ORGS]);
  await query(`DELETE FROM outbox WHERE org_id = ANY($1)`, [ORGS]);
  await query(`DELETE FROM inbound_queue WHERE message_id LIKE 'thr-msg-%'`);
  await query(`DELETE FROM conversation_window WHERE phone = ANY($1)`, [TELS]);
}

afterAll(async () => {
  if (!hasDb) return;
  await limpar();
  await db().end();
});

d("GET /api/admin/threads", () => {
  beforeEach(async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
    await limpar();
  });

  it("recusa sem assinatura", async () => {
    const { GET } = await import("@/app/api/admin/threads/route");
    const res = await GET(new NextRequest("http://max.test/api/admin/threads?orgId=x"));
    expect(res.status).toBe(401);
  });

  it("a assinatura cobre o orgId: trocar a org de uma URL assinada dá 401", async () => {
    const { GET } = await import("@/app/api/admin/threads/route");
    const ts = String(Date.now());
    const res = await GET(
      new NextRequest(`http://max.test/api/admin/threads?orgId=${ORG_B}`, {
        headers: {
          "x-max-timestamp": ts,
          "x-max-signature": sign(ts, `GET./api/admin/threads?orgId=${ORG_A}`, SECRET),
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it("a assinatura cobre q e cursor também, não só o orgId", async () => {
    const { GET } = await import("@/app/api/admin/threads/route");
    const base = `/api/admin/threads?orgId=${ORG_A}`;
    for (const trocado of [`${base}&q=0001`, `${base}&cursor=x`]) {
      const ts = String(Date.now());
      const res = await GET(
        new NextRequest(`http://max.test${trocado}`, {
          headers: { "x-max-timestamp": ts, "x-max-signature": sign(ts, `GET.${base}`, SECRET) },
        })
      );
      expect(res.status).toBe(401);
    }
  });

  it("sem orgId e sem scope=all é 400, não 'todas as orgs'", async () => {
    expect((await lista("")).status).toBe(400);
  });

  it("uma linha por pessoa, só da org pedida, contando turns e avisos da org", async () => {
    await turn(ORG_A, TEL_AMBAS);
    await turn(ORG_A, TEL_AMBAS);
    await aviso(ORG_A, TEL_AMBAS, { nome: "Ana Corretora" });
    await turn(ORG_A, TEL_SO_A);
    // O mesmo número na org B, com mais turns e um erro: nada disso conta em A.
    await turn(ORG_B, TEL_AMBAS, { erro: "falhou em B" });
    await turn(ORG_B, TEL_AMBAS);
    await turn(ORG_B, TEL_AMBAS);
    await turn(ORG_B, TEL_SO_B);

    const body = await (await lista(`?orgId=${ORG_A}`)).json();
    expect(body.threads).toHaveLength(2);
    const ambas = body.threads.find((t: { key: string }) => t.key === phoneTag(TEL_AMBAS));
    expect(ambas).toMatchObject({
      orgId: ORG_A, turns: 2, avisos: 1, temErro: false, nome: "Ana Corretora",
      phone: "5511***0001",
    });
    expect(body.threads.map((t: { key: string }) => t.key)).not.toContain(phoneTag(TEL_SO_B));
  });

  it("scope=all separa o mesmo telefone em duas threads, uma por org", async () => {
    await turn(ORG_A, TEL_AMBAS);
    await turn(ORG_B, TEL_AMBAS);
    const body = await (await lista("?scope=all&limit=100")).json();
    const doTel = body.threads.filter((t: { key: string }) => t.key === phoneTag(TEL_AMBAS));
    expect(doTel.map((t: { orgId: string }) => t.orgId).sort()).toEqual([ORG_A, ORG_B]);
  });

  it("q: 4 dígitos finais ou nome sem acento; menos de 4 dígitos é recusado", async () => {
    await aviso(ORG_A, TEL_AMBAS, { nome: "Joana Araújo" });
    await turn(ORG_A, TEL_SO_A);

    const porDigito = await (await lista(`?orgId=${ORG_A}&q=0002`)).json();
    expect(porDigito.threads.map((t: { key: string }) => t.key)).toEqual([phoneTag(TEL_SO_A)]);

    const porNome = await (await lista(`?orgId=${ORG_A}&q=araujo`)).json();
    expect(porNome.threads.map((t: { key: string }) => t.key)).toEqual([phoneTag(TEL_AMBAS)]);

    expect((await lista(`?orgId=${ORG_A}&q=002`)).status).toBe(400);
  });

  it("paginação da lista: empate no mesmo instante não perde nem repete", async () => {
    const em = "2026-09-20T12:00:00.000000Z";
    await turn(ORG_A, TEL_AMBAS, { em });
    await turn(ORG_A, TEL_SO_A, { em });
    await turn(ORG_A, TEL_SO_B, { em });

    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs: string = `?orgId=${ORG_A}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: { threads: { key: string }[]; nextCursor: string | null } = await (await lista(qs)).json();
      vistos.push(...body.threads.map((t: { key: string }) => t.key));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(vistos.sort()).toEqual(TELS.map(phoneTag).sort());
  });

  it("nenhum telefone cru na resposta da lista", async () => {
    await turn(ORG_A, TEL_AMBAS);
    await aviso(ORG_A, TEL_SO_A);
    const texto = await (await lista(`?orgId=${ORG_A}`)).text();
    for (const t of TELS) expect(texto).not.toContain(t.slice(2));
    // Controle positivo: o oráculo acha o número quando ele ESTÁ no texto.
    expect(`x${TEL_AMBAS}x`).toContain(TEL_AMBAS.slice(2));
  });
});

d("GET /api/admin/threads/<key>", () => {
  beforeEach(async () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", SECRET);
    await limpar();
  });

  it("a linha do tempo junta turns e avisos DA ORG, mesmo com o telefone nas duas", async () => {
    await turn(ORG_A, TEL_AMBAS, { texto: "pergunta em A", em: "2026-09-20T10:00:00.000000Z" });
    await aviso(ORG_A, TEL_AMBAS, { em: "2026-09-20T11:00:00.000000Z" });
    await turn(ORG_B, TEL_AMBAS, { texto: "SEGREDO DA ORG B" });
    await aviso(ORG_B, TEL_AMBAS);

    const res = await detalhe(phoneTag(TEL_AMBAS), `?orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eventos.map((e: { origem: string }) => e.origem)).toEqual(["aviso", "turn"]);
    expect(JSON.stringify(body)).not.toContain("SEGREDO DA ORG B");
  });

  it("404 idêntico: tag de outra org e tag inexistente", async () => {
    await turn(ORG_B, TEL_SO_B);
    await turn(ORG_A, TEL_SO_A);

    const deOutraOrg = await detalhe(phoneTag(TEL_SO_B), `?orgId=${ORG_A}`);
    const inexistente = await detalhe("tel_000000000000", `?orgId=${ORG_A}`);
    const malformada = await detalhe("5511987650003", `?orgId=${ORG_A}`);
    for (const r of [deOutraOrg, inexistente, malformada]) expect(r.status).toBe(404);
    const corpos = await Promise.all([deOutraOrg, inexistente, malformada].map((r) => r.text()));
    expect(new Set(corpos).size).toBe(1);

    // Controle positivo: a mesma tag, na org dela, existe.
    expect((await detalhe(phoneTag(TEL_SO_B), `?orgId=${ORG_B}`)).status).toBe(200);
  });

  it("sem orgId é 400: não existe linha do tempo 'de todas as orgs'", async () => {
    expect((await detalhe(phoneTag(TEL_SO_A), "")).status).toBe(400);
  });

  it("entrega da resposta vem da fila pelo message_id do turn", async () => {
    await query(
      `INSERT INTO inbound_queue (id, message_id, from_phone, kind, status, reply_delivery_status)
       VALUES ('thr-iq-1','thr-msg-1',$1,'text','done','read')`,
      [TEL_SO_A]
    );
    await turn(ORG_A, TEL_SO_A, { messageId: "thr-msg-1" });
    const body = await (await detalhe(phoneTag(TEL_SO_A), `?orgId=${ORG_A}`)).json();
    expect(body.eventos[0].entrega.status).toBe("read");
  });

  it("nenhum telefone cru na linha do tempo, nem dentro de mensagem de erro", async () => {
    await turn(ORG_A, TEL_SO_A, { erro: `falha ao enviar para ${TEL_SO_A}` });
    await aviso(ORG_A, TEL_SO_A, {
      status: "failed", errorCode: 131026, lastError: `destinatário +${TEL_SO_A} inválido`,
    });
    // Formatos que provedor usa: com espaço, traço e parênteses.
    await turn(ORG_A, TEL_SO_A, { erro: "destinatário inválido: 55 11 98765-0002" });
    await aviso(ORG_A, TEL_SO_A, { status: "failed", lastError: "número (11) 98765-0002 recusado" });
    const texto = await (await detalhe(phoneTag(TEL_SO_A), `?orgId=${ORG_A}&limit=100`)).text();
    expect(texto.replace(/\D/g, "")).not.toContain(TEL_SO_A.slice(4));
    expect(texto).toContain("131026");
  });

  it("paginação da linha do tempo: empate no mesmo instante não perde nem repete", async () => {
    const em = "2026-09-20T12:00:00.123456Z";
    for (let i = 0; i < 3; i++) await turn(ORG_A, TEL_SO_A, { em, texto: `t${i}` });
    for (let i = 0; i < 2; i++) await aviso(ORG_A, TEL_SO_A, { em });

    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const qs: string = `?orgId=${ORG_A}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: { eventos: { id: string }[]; nextCursor: string | null } = await (await detalhe(phoneTag(TEL_SO_A), qs)).json();
      ids.push(...body.eventos.map((e: { id: string }) => e.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});
