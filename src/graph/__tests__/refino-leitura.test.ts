import { afterEach, describe, expect, it, vi } from "vitest";
import { ferramentasDoTurno, pedidoDeRefino } from "../tools";
import { buildSystemPrompt } from "../prompt";
import type { Capability } from "../policy";

/**
 * Evals do Newton de 23/10: refino curto ("e em contrato?", "quais eram
 * mesmo?") chegava sem tool de leitura nenhuma, porque o prefiltro só olhava
 * a mensagem do turno. Sem a tool, o modelo perguntava de novo ou repetia o
 * dado velho (contado como número sem consulta). O refino herda a LEITURA do
 * pedido anterior; a escrita nunca herda por aqui.
 */
const identity = { kind: "user" as const, orgId: "org-qa", orgName: "QA", userId: "u1", userName: "QA" };
const LEITURA: Capability[] = ["deal.list", "deal.pending", "activity.list"];
const hist = (...falas: [string, string][]) => falas.map(([role, content]) => ({ role, content }));

afterEach(() => vi.unstubAllEnvs());

function nomes(texto: string, policy: Capability[], textoDeRefino?: string | null) {
  return ferramentasDoTurno({ policy, texto, identity, textoDeRefino }).entradas.map((e) => e.nome);
}

describe("pedidoDeRefino", () => {
  const anterior = hist(["user", "meus negócios"], ["assistant", "1) Apto 302 — Contrato"]);

  it.each(["e em contrato?", "e os de locação?", "quais eram mesmo?", "só os de venda", "agora os atrasados", "mostra de novo", "os de venda", "as que vencem hoje"])(
    "%s herda o pedido anterior",
    (texto) => expect(pedidoDeRefino(texto, anterior)).toBe("meus negócios")
  );

  it.each(["bom dia, tudo bem?", "obrigado", "como funciona a assinatura da proposta e quanto tempo leva em média pra sair?"])(
    "%s não é refino",
    (texto) => expect(pedidoDeRefino(texto, anterior)).toBeNull()
  );

  it("sem pedido anterior da pessoa, nada a herdar", () => {
    expect(pedidoDeRefino("e em contrato?", hist(["assistant", "Oi!"]))).toBeNull();
    expect(pedidoDeRefino("e em contrato?", [])).toBeNull();
  });

  it("herda o último pedido da pessoa, não o anterior a ele", () => {
    const h = hist(["user", "minhas atividades"], ["assistant", "1) Ligar"], ["user", "meus negócios"], ["assistant", "1) Apto"]);
    expect(pedidoDeRefino("e em contrato?", h)).toBe("meus negócios");
  });
});

describe("refino herda só a leitura", () => {
  it("'e em contrato?' depois de 'meus negócios' oferece listar_negocios", () => {
    expect(nomes("e em contrato?", LEITURA)).not.toContain("listar_negocios");
    expect(nomes("e em contrato?", LEITURA, "meus negócios")).toContain("listar_negocios");
  });

  it("continua exigindo a capability", () => {
    expect(nomes("e em contrato?", [], "meus negócios")).toEqual([]);
  });

  it("escrita nunca herda pelo refino", () => {
    const comEscrita: Capability[] = [...LEITURA, "form.create", "proposal.create", "activity.write"];
    const n = nomes("e a segunda?", comEscrita, "cria uma proposta pro Apto 302");
    expect(n).not.toContain("propor_criacao");
    expect(n.some((x) => x.endsWith("_atividade") && x !== "ver_atividade")).toBe(false);
  });

  it("pedido de criação no turno continua sem leitura, com ou sem refino", () => {
    expect(nomes("cria uma proposta", ["deal.list", "proposal.create"], "meus negócios")).toEqual(["propor_criacao"]);
  });
});

describe("'pra hoje' chega às atividades", () => {
  it.each(["o que eu tenho pra hoje?", "o que vence amanhã?", "tem algo vencendo?"])("%s oferece listar_atividades", (texto) => {
    vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ "org-qa": ["queries"] }));
    vi.stubEnv("MAX_EXTENDED_QUERIES", "true");
    expect(nomes(texto, LEITURA)).toContain("listar_atividades");
  });
});

describe("atividades só leitura no prompt", () => {
  const base = { orgName: "QA", hits: [] };

  it("com a regra, diz que não altera e aponta a tela", () => {
    const p = buildSystemPrompt({ ...base, atividades: "so_leitura" });
    expect(p).toMatch(/só consulta atividades/i);
    expect(p).toMatch(/tela de atividades/i);
    expect(p.indexOf("só consulta atividades")).toBeLessThan(p.indexOf("Você atende a QA."));
  });

  it("sem a regra, o prompt não fala nisso", () => {
    expect(buildSystemPrompt(base)).not.toMatch(/só consulta atividades/i);
  });
});
