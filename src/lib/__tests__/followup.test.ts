import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));
vi.mock("../acao", () => ({ executarAcao: vi.fn() }));
vi.mock("../outbox", () => ({ enqueue: vi.fn() }));
vi.mock("../orgs", () => ({ orgById: vi.fn() }));

const f = await import("../followup");
const { query } = await import("../db");
const { executarAcao } = await import("../acao");
const { enqueue } = await import("../outbox");
const { orgById } = await import("../orgs");

const q = vi.mocked(query);
const acao = vi.mocked(executarAcao);
const enq = vi.mocked(enqueue);

const SUBJECT = { kind: "user", userId: "u1" };
const job = (o: Record<string, unknown> = {}) => ({
  id: "j1", org_id: "org1", phone: "5511987654321", ref_id: "cap-1", dedupe_key: "captacao-envio:cap-1:m5",
  subject: SUBJECT, attempt: 0, deadline_at: new Date(Date.now() + 4 * 60_000), ...o,
});
const lista = (estado: string) => ({
  status: 200,
  body: { items: [{ ref: 1, id: "cap-1", codigo: "CAP-2026-0001", nome: "Apto da Dona Maria", estado }] },
});
/** Claim devolve `rows`; as demais queries (UPDATE do job) devolvem vazio. */
const comClaim = (...rows: unknown[]) => q.mockResolvedValueOnce(rows as never);
const updates = () => q.mock.calls.slice(1).map(([sql, p]) => ({ sql: String(sql), p: p as unknown[] }));

beforeEach(() => {
  vi.resetAllMocks();
  q.mockResolvedValue([] as never);
  vi.mocked(orgById).mockResolvedValue({ orgId: "org1", orgName: "FINCasa", apiToken: "t" });
  enq.mockResolvedValue({ status: "queued", id: "o1", deliverAfter: new Date() });
});

describe("agendarConferenciaDeEnvio / concluirConferenciaDeEnvio", () => {
  it("grava o job com a dedupe key captacao-envio:<captacaoId>:<messageId>, ON CONFLICT DO NOTHING, sujeito e prazo de 5 min", async () => {
    await f.agendarConferenciaDeEnvio({ orgId: "org1", phone: "5511987654321", subject: { kind: "user", userId: "u1" } }, { captacaoId: "cap-1", messageId: "m5" });
    const [sql, p] = q.mock.calls[0]!;
    expect(String(sql)).toMatch(/INSERT INTO followup_job/);
    expect(String(sql)).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
    expect(p).toEqual([expect.any(String), "org1", "5511987654321", "captacao_envio", "cap-1", "captacao-envio:cap-1:m5", JSON.stringify(SUBJECT), 30, 300]);
  });

  it("falha de banco propaga (quem chama trata como best-effort)", async () => {
    q.mockRejectedValueOnce(new Error("sem tabela"));
    await expect(f.agendarConferenciaDeEnvio({ orgId: "o", phone: "p", subject: { kind: "user", userId: "u" } }, { captacaoId: "c", messageId: "m" })).rejects.toThrow("sem tabela");
  });

  it("concluir: só pendentes da captação DESTA org, status done", async () => {
    await f.concluirConferenciaDeEnvio("org1", "cap-1");
    const [sql, p] = q.mock.calls[0]!;
    expect(String(sql)).toMatch(/status = 'done'/);
    expect(String(sql)).toMatch(/status = 'pending'/);
    expect(String(sql)).toMatch(/ref_id = \$3/);
    expect(p).toEqual(["captacao_envio", "org1", "cap-1"]);
  });
});

describe("processarFollowups", () => {
  it("o claim usa FOR UPDATE SKIP LOCKED e empurra next_at (aluguel), em lote pequeno", async () => {
    comClaim();
    const t = await f.processarFollowups();
    expect(t).toEqual({ claimed: 0, avisados: 0, reagendados: 0, desistidos: 0 });
    const [sql, p] = q.mock.calls[0]!;
    expect(String(sql)).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(String(sql)).toMatch(/SET next_at = now\(\) \+ make_interval/);
    expect(String(sql)).toMatch(/status = 'pending' AND next_at <= now\(\)/);
    expect(p).toEqual([5, 120]);
    expect(acao).not.toHaveBeenCalled();
  });

  it("consulta o captacao.list da captação como o sujeito e o telefone guardados no job", async () => {
    comClaim(job());
    acao.mockResolvedValue(lista("Enviando…"));
    await f.processarFollowups();
    expect(acao).toHaveBeenCalledWith({ orgId: "org1", rawPhone: "5511987654321", subject: SUBJECT, verb: "captacao.list", args: { captacaoId: "cap-1" } });
  });

  it.each([[0, 30], [1, 60], [2, 120], [7, 120]])("ainda Enviando (tentativa %i): attempt+1, backoff de %i s, nenhuma mensagem", async (attempt, espera) => {
    comClaim(job({ attempt }));
    acao.mockResolvedValue(lista("Enviando…"));
    const t = await f.processarFollowups();
    expect(t).toMatchObject({ claimed: 1, reagendados: 1, avisados: 0, desistidos: 0 });
    expect(enq).not.toHaveBeenCalled();
    const [u] = updates();
    expect(u!.sql).toMatch(/attempt = attempt \+ 1, next_at = now\(\) \+ make_interval/);
    expect(u!.p).toEqual(["j1", espera]);
  });

  it("estado final: UMA mensagem no outbox com a chave do job e o texto combinado; marca done", async () => {
    comClaim(job());
    acao.mockResolvedValue(lista("Em assinatura"));
    const t = await f.processarFollowups();
    expect(t).toMatchObject({ avisados: 1, reagendados: 0 });
    expect(enq).toHaveBeenCalledTimes(1);
    const p = enq.mock.calls[0]![0];
    expect(p).toMatchObject({ orgId: "org1", dedupeKey: "captacao-envio:cap-1:m5", phone: "5511987654321", audience: "platform_user", orgName: "FINCasa" });
    expect(p.body).toMatch(/^A captação Apto da Dona Maria foi enviada para assinatura \(Em assinatura\)\. Acompanhe: https?:\/\/\S+\/imoveis\/captacoes\/cap-1$/);
    expect(p.body).not.toContain("**");
    const [u] = updates();
    expect(u!.sql).toMatch(/status = 'done'/);
    expect(u!.p).toEqual(["j1"]);
  });

  it("estado final de FALHA nunca é dito como 'concluído'", async () => {
    comClaim(job());
    acao.mockResolvedValue(lista("Falha no envio"));
    await f.processarFollowups();
    const p = enq.mock.calls[0]![0];
    expect(p.body).toMatch(/^O envio da captação Apto da Dona Maria não foi concluído \(Falha no envio\)\. Veja na tela: /);
    expect(p.body).not.toMatch(/concluído:/);
  });

  // Rótulos do `captacaoStatusView` do ImobPro (status-view.ts). Smoke 26/11: "concluído: Renova em 173 dias".
  it.each([
    ["Em assinatura · 1 de 3", /^A captação Apto da Dona Maria foi enviada para assinatura \(Em assinatura · 1 de 3\)\. Acompanhe: /],
    ["Assinada", /^A captação Apto da Dona Maria já está assinada\. https?:/],
    ["Renova em 173 dias", /^A captação Apto da Dona Maria já está assinada \(Renova em 173 dias\)\. /],
    ["Renovação automática", /já está assinada \(Renovação automática\)\. /],
    ["Vigente até 26/05/2027", /já está assinada \(Vigente até 26\/05\/2027\)\. /],
    ["Vence em 3 dias", /já está assinada \(Vence em 3 dias\)\. /],
    ["Termina hoje", /já está assinada \(Termina hoje\)\. /],
    ["Sem prazo", /já está assinada \(Sem prazo\)\. /],
    ["Renova amanhã", /já está assinada \(Renova amanhã\)\. /],
    ["Vence hoje", /já está assinada \(Vence hoje\)\. /],
    ["Vencida há 3 dias", /^A captação Apto da Dona Maria foi assinada, mas a vigência terminou \(Vencida há 3 dias\)\. /],
    ["Encerrada em 01/01/2026", /foi assinada, mas a vigência terminou \(Encerrada em 01\/01\/2026\)\. /],
    ["Recusada", /não foi concluído \(Recusada\)\. Veja na tela: /],
    ["Recusada por Maria", /não foi concluído \(Recusada por Maria\)\. Veja na tela: /],
    ["Cancelada", /não foi concluído \(Cancelada\)/],
    ["Assinatura expirada", /não foi concluído \(Assinatura expirada\)/],
    ["Arquivada", /não foi concluído \(Arquivada\)/],
    ["Rascunho", /não foi concluído \(Rascunho\)/],
    ["Situação desconhecida", /^Confira a situação da captação Apto da Dona Maria na tela \(Situação desconhecida\): /],
  ])("estado %s: texto certo, nunca 'concluído:'", async (estado, esperado) => {
    comClaim(job());
    acao.mockResolvedValue(lista(estado));
    await f.processarFollowups();
    const p = enq.mock.calls[0]![0];
    expect(p.body).toMatch(esperado);
    expect(p.body).not.toMatch(/concluído:/);
    expect(p.body).not.toContain("**");
  });

  it("repetido (claim devolve o mesmo job de novo): o outbox dedupa pela chave, ninguém recebe duas", async () => {
    const vistas = new Set<string>();
    enq.mockImplementation(async (p) => {
      if (vistas.has(p.dedupeKey)) return { status: "duplicate", id: "o1" };
      vistas.add(p.dedupeKey);
      return { status: "queued", id: "o1", deliverAfter: new Date() };
    });
    acao.mockResolvedValue(lista("Em assinatura"));
    comClaim(job());
    await f.processarFollowups();
    comClaim(job());
    const t = await f.processarFollowups();
    expect(enq).toHaveBeenCalledTimes(2);
    expect(new Set(enq.mock.calls.map(([p]) => p.dedupeKey)).size).toBe(1);
    expect(vistas.size).toBe(1);
    expect(t.avisados).toBe(1); // duplicate também encerra o job
  });

  it("passou do deadline e ainda Enviando: gave_up, sem mensagem", async () => {
    comClaim(job({ deadline_at: new Date(Date.now() - 1_000) }));
    acao.mockResolvedValue(lista("Enviando…"));
    const t = await f.processarFollowups();
    expect(t).toMatchObject({ desistidos: 1, avisados: 0 });
    expect(enq).not.toHaveBeenCalled();
    expect(updates()[0]!.sql).toMatch(/status = 'gave_up'/);
  });

  it("passou do deadline mas o CM já mostra o estado final: avisa mesmo assim (é verdade confirmada)", async () => {
    comClaim(job({ deadline_at: new Date(Date.now() - 1_000) }));
    acao.mockResolvedValue(lista("Em assinatura"));
    const t = await f.processarFollowups();
    expect(t.avisados).toBe(1);
    expect(enq).toHaveBeenCalledTimes(1);
  });

  it("o CM não respondeu (null) ou deu 4xx: nunca afirma envio; backoff", async () => {
    comClaim(job(), job({ id: "j2", dedupe_key: "captacao-envio:cap-1:m6" }));
    acao.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 403, body: { error: "capability_disabled" } });
    const t = await f.processarFollowups();
    expect(t.reagendados).toBe(2);
    expect(enq).not.toHaveBeenCalled();
  });

  it("captação fora da lista ou sem estado: não avisa", async () => {
    comClaim(job());
    acao.mockResolvedValue({ status: 200, body: { items: [] } });
    const t = await f.processarFollowups();
    expect(t.reagendados).toBe(1);
    expect(enq).not.toHaveBeenCalled();
  });

  it("o enqueue falha: não marca done, cai no backoff (e desiste no prazo)", async () => {
    comClaim(job());
    acao.mockResolvedValue(lista("Em assinatura"));
    enq.mockRejectedValueOnce(new Error("outbox fora"));
    const t = await f.processarFollowups();
    expect(t).toMatchObject({ avisados: 0, reagendados: 1 });
    expect(updates().some((u) => /status = 'done'/.test(u.sql))).toBe(false);
    expect(updates()[0]!.sql).toMatch(/attempt = attempt \+ 1/);
  });

  it("sujeito ilegível no job: desiste sem consultar o CM", async () => {
    comClaim(job({ subject: { kind: "x" } }));
    const t = await f.processarFollowups();
    expect(t.desistidos).toBe(1);
    expect(acao).not.toHaveBeenCalled();
  });

  it("claim falha: não lança, devolve zeros", async () => {
    q.mockRejectedValueOnce(new Error("sem tabela"));
    await expect(f.processarFollowups()).resolves.toEqual({ claimed: 0, avisados: 0, reagendados: 0, desistidos: 0 });
  });
});
