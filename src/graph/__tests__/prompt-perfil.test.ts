import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../prompt";

/**
 * O prompt do Max não pode mudar por causa do perfil de deploy. O snapshot foi
 * gravado ANTES de o nome sair do perfil (base 20d8a6f); com o perfil
 * ausente, o texto tem de ser byte a byte o mesmo.
 */
const CORRETOR_SEM_TOOLS = { orgName: "RE/MAX Trio", userName: "Ana", hits: [], podeEscrever: true };
const GERENTE_COM_LEITURA = {
  orgName: "RE/MAX Trio",
  userName: "Marcia",
  hits: [
    {
      id: "k1",
      title: "Como funciona o formulário",
      content: "O cliente preenche em 7 etapas.",
      similarity: 0.72,
      lowConfidence: false,
    },
  ],
  summary: "Falamos do negócio AP1011.",
  facts: "- prefere respostas curtas",
  criacao: "disponivel" as const,
  toolResults: [{ tool: "listar_negocios", items: [{ codigo: "AP1011" }], truncated: false }],
};
const DESCONHECIDO = { orgName: "RE/MAX Trio", userName: null, hits: [], podeEscrever: false };

afterEach(() => vi.unstubAllEnvs());

describe("prompt por perfil", () => {
  it("perfil ausente: corretor sem tools igual ao baseline", () => {
    expect(buildSystemPrompt(CORRETOR_SEM_TOOLS)).toMatchSnapshot();
  });

  it("perfil ausente: gerente com tools de leitura igual ao baseline", () => {
    expect(buildSystemPrompt(GERENTE_COM_LEITURA)).toMatchSnapshot();
  });

  it("perfil ausente: pessoa desconhecida igual ao baseline", () => {
    expect(buildSystemPrompt(DESCONHECIDO)).toMatchSnapshot();
  });

  it("perfil max explícito: mesmo texto do perfil ausente", () => {
    const ausente = buildSystemPrompt(GERENTE_COM_LEITURA);
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
    expect(buildSystemPrompt(GERENTE_COM_LEITURA)).toBe(ausente);
  });
});

describe("prompt do Newton", () => {
  it("perfil newton: prompt sem 'Max' e com 'Newton'", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    for (const entrada of [CORRETOR_SEM_TOOLS, GERENTE_COM_LEITURA, DESCONHECIDO]) {
      const p = buildSystemPrompt(entrada);
      expect(p).not.toMatch(/\bMax\b/);
      expect(p).toContain("Você é o Newton");
    }
  });

  it("perfil newton: a regra das pendências está no prompt", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    for (const entrada of [CORRETOR_SEM_TOOLS, GERENTE_COM_LEITURA, DESCONHECIDO]) {
      const p = buildSystemPrompt(entrada).replace(/\s+/g, " ");
      expect(p).toContain("diga sempre o total exato de cada bloco");
      expect(p).toContain("no máximo 5 itens por bloco");
      expect(p).toContain("pergunta genérica = formulários, propostas e atividades");
      expect(p).toContain("pergunta específica = só o bloco pedido");
      expect(p).toContain("os itens de dentro de cada formulário já vêm limitados");
      expect(p).toContain("sem_permissao");
    }
  });
});
