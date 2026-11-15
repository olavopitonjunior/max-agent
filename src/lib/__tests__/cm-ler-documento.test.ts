import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `cm.lerDocumento` (PR-B/T8, Rodada 1): o mapeamento de status do `document.read` para o motivo
 * que o fluxo traduz em frase. O funil de ações é mockado; aqui só importa o que sai.
 */

const executarAcao = vi.fn();
vi.mock("../acao", () => ({ executarAcao: (...a: unknown[]) => executarAcao(...a) }));

import { lerDocumento } from "../cm";

const args = {
  orgId: "org1",
  rawPhone: "5511999999999",
  subject: { kind: "user", userId: "u1" } as never,
  base64: "AAAA",
  mimeType: "image/jpeg",
  alvo: "proposta" as const,
  idempotencyKey: "wamid.FOTO1",
};

const corpo = (over: Record<string, unknown> = {}) => ({
  documentType: "rg",
  confianca: 0.9,
  campos: [{ path: "compradores[0].nome", valor: "Maria Teste", confianca: 0.9 }],
  ...over,
});

beforeEach(() => executarAcao.mockReset());

describe("lerDocumento: status do servidor -> motivo", () => {
  it("504 processando (o prazo estourou, o servidor segue) é 'processando', nunca 'falha'", async () => {
    executarAcao.mockResolvedValue({ status: 504, body: { error: "processando" } });
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "processando" });
  });

  it("403 fluxo_desligado é o gate do v2 (rebaixa); outro 403 segue 'politica'", async () => {
    executarAcao.mockResolvedValue({ status: 403, body: { error: "fluxo_desligado" } });
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "fluxo_desligado" });
    executarAcao.mockResolvedValue({ status: 403, body: { error: "forbidden" } });
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "politica" });
  });

  it("sem resposta (null) segue 'falha'", async () => {
    executarAcao.mockResolvedValue(null);
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "falha" });
  });

  it("200 válido devolve os campos", async () => {
    executarAcao.mockResolvedValue({ status: 200, body: corpo() });
    const r = await lerDocumento(args);
    expect(r.ok).toBe(true);
  });
});

describe("lerDocumento: confianca fora do contrato (M8)", () => {
  it.each([1.5, -0.1, 2])("confianca geral %s é recusada como falha", async (c) => {
    executarAcao.mockResolvedValue({ status: 200, body: corpo({ confianca: c }) });
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "falha" });
  });

  it("confianca de um campo fora de [0,1] também recusa a leitura", async () => {
    executarAcao.mockResolvedValue({
      status: 200,
      body: corpo({ campos: [{ path: "compradores[0].nome", valor: "Maria Teste", confianca: 7 }] }),
    });
    expect(await lerDocumento(args)).toEqual({ ok: false, motivo: "falha" });
  });

  it("os limites 0 e 1 valem", async () => {
    executarAcao.mockResolvedValue({
      status: 200,
      body: corpo({ confianca: 0, campos: [{ path: "compradores[0].nome", valor: "M", confianca: 1 }] }),
    });
    expect((await lerDocumento(args)).ok).toBe(true);
  });
});
