import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));

process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const { renderMessage, textoDeSemente, limparCorposSelados, cancelarPendentesPorPrefixo, TEXTO_FICHA_INDISPONIVEL } =
  await import("../outbox");
const { query } = await import("../db");
const { selarCorpo, PREFIXO_DO_SELO } = await import("@/graph/formularios/selo");
const { MARCADOR_DOCUMENTO_LIDO } = await import("@/graph/formularios/midia");

const FICHA = "Lido do documento: *Maria Teste da Silva*, CPF ***.456.789-**";
const ORG = "org1";
const FONE = "5511999990000";

function linha(body: string, extra: Record<string, unknown> = {}) {
  return {
    title: "Ficha do rascunho",
    body,
    link_url: null,
    org_name: "Imob Teste",
    recipient_name: "Ana Souza",
    org_id: ORG,
    phone: FONE,
    ...extra,
  };
}

describe("I5: ficha selada no outbox", () => {
  it("renderMessage abre o corpo selado (org|telefone) para sair no WhatsApp", () => {
    const out = renderMessage(linha(selarCorpo(FICHA, `${ORG}|${FONE}`)));
    expect(out).toContain("Maria Teste da Silva");
    expect(out).not.toContain(PREFIXO_DO_SELO);
  });

  it("negado: corpo selado para outro telefone não vaza nada, vira o texto genérico", () => {
    const out = renderMessage(linha(selarCorpo(FICHA, `${ORG}|5511888880000`)));
    expect(out).not.toContain("Maria");
    expect(out).not.toContain(PREFIXO_DO_SELO);
    expect(out).toContain(TEXTO_FICHA_INDISPONIVEL);
  });

  it("negado: selado e sem org_id/phone na linha (não dá para montar o AAD) não vaza", () => {
    const out = renderMessage({ ...linha(selarCorpo(FICHA, `${ORG}|${FONE}`)), org_id: undefined, phone: undefined });
    expect(out).not.toContain("Maria");
    expect(out).toContain(TEXTO_FICHA_INDISPONIVEL);
  });

  it("linha comum (não selada) segue igual", () => {
    expect(renderMessage(linha("corpo normal"))).toContain("corpo normal");
  });

  it("a semente do thread usa o marcador (nunca o valor) quando o corpo é selado", () => {
    expect(textoDeSemente(linha(selarCorpo(FICHA, `${ORG}|${FONE}`)))).toBe(MARCADOR_DOCUMENTO_LIDO);
    expect(textoDeSemente(linha("corpo normal"))).toContain("corpo normal");
  });

  it("cancelar a ficha pendente também zera o corpo (não fica valor numa linha derrubada)", async () => {
    vi.mocked(query).mockResolvedValueOnce([{ id: "a" }] as never);
    await cancelarPendentesPorPrefixo("ficha:org1|u1:");
    const [sql] = vi.mocked(query).mock.calls.at(-1)!;
    expect(String(sql)).toMatch(/body = ''/);
  });

  describe("varredura (limparCorposSelados)", () => {
    afterEach(() => vi.unstubAllEnvs());
    const ligar = () => {
      vi.stubEnv("MAX_FORMULARIOS_V2", "true");
      vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
    };

    it("negado: com a flag OFF (global ou sem nenhuma org) nenhuma consulta é feita", async () => {
      vi.mocked(query).mockClear();
      vi.stubEnv("MAX_FORMULARIOS_V2", "");
      vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["formularios_v2"] }));
      expect(await limparCorposSelados()).toBe(0);
      vi.stubEnv("MAX_FORMULARIOS_V2", "true");
      vi.stubEnv("MAX_ROLLOUT_ORGS", "{}");
      expect(await limparCorposSelados()).toBe(0);
      vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ [ORG]: ["queries"] }));
      expect(await limparCorposSelados()).toBe(0);
      vi.stubEnv("MAX_ROLLOUT_ORGS", "json quebrado");
      expect(await limparCorposSelados()).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it("zera só corpo SELADO de linha já enviada/derrubada/falha, nunca de pendente, e com LIMIT", async () => {
      ligar();
      vi.mocked(query).mockClear();
      vi.mocked(query).mockResolvedValueOnce([{ id: "a" }, { id: "b" }] as never);
      expect(await limparCorposSelados()).toBe(2);
      const [sql] = vi.mocked(query).mock.calls.at(-1)!;
      expect(String(sql)).toMatch(/body = ''/);
      expect(String(sql)).toMatch(/status IN \('sent', 'dropped', 'failed'\)/);
      expect(String(sql)).not.toMatch(/'pending'/);
      expect(String(sql)).not.toMatch(/'sending'/);
      // predicado literal (casa com o índice parcial da migration 030) e lote limitado
      expect(String(sql)).toContain(`starts_with(body, '${PREFIXO_DO_SELO}')`);
      expect(String(sql)).toMatch(/LIMIT \d+/);
    });

    // Rodada 3 (M-A): o 131047 assíncrono devolve a linha `sent` a `pending` (delivery.ts) para o
    // reenvio por template. Se o corpo já tivesse sido zerado, o reenvio sairia sem a ficha.
    it("não zera o corpo de linha `sent` dentro da carência do 131047 (sent recente fica selada)", async () => {
      ligar();
      vi.mocked(query).mockClear();
      vi.mocked(query).mockResolvedValueOnce([] as never);
      await limparCorposSelados();
      const sql = String(vi.mocked(query).mock.calls.at(-1)![0]);
      expect(sql).toMatch(/status <> 'sent'\s+OR\s+sent_at IS NULL\s+OR\s+sent_at < now\(\) - interval '1 hour'/);
      // dropped/failed não voltam a pending por esse caminho: seguem sem carência
      expect(sql).toMatch(/status IN \('sent', 'dropped', 'failed'\)/);
    });
  });
});
