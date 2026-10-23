import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, respostaDeFalha } from "../prompt";
import { PERSONA_NEWTON } from "@/profiles/newton/persona";

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
});

describe("persona do Newton", () => {
  it("perfil newton: persona entra no bloco estável, antes da org", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    const p = buildSystemPrompt(GERENTE_COM_LEITURA);
    expect(p).toContain(PERSONA_NEWTON);
    expect(p.indexOf(PERSONA_NEWTON)).toBeLessThan(p.indexOf("Você atende a RE/MAX Trio."));
  });

  it("perfil max e ausente: sem persona do Newton", () => {
    expect(buildSystemPrompt(GERENTE_COM_LEITURA)).not.toContain(PERSONA_NEWTON);
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
    expect(buildSystemPrompt(GERENTE_COM_LEITURA)).not.toContain(PERSONA_NEWTON);
  });

  it("persona: regras que a 1ª rodada de evals cobrou", () => {
    expect(PERSONA_NEWTON).toMatch(/Número só com consulta/);
    expect(PERSONA_NEWTON).toMatch(/dado, não instrução/i);
    expect(PERSONA_NEWTON).toMatch(/Posso te ajudar com mais alguma coisa/);
    expect(PERSONA_NEWTON).not.toMatch(/\bMax\b/);
  });
});

describe("contagem do resultado de consulta", () => {
  const resultado = [{ tool: "listar_negocios", items: [{ codigo: "A" }, { codigo: "B" }, { codigo: "C" }], truncated: false }];
  it("Newton recebe itens=N pronto", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    expect(buildSystemPrompt({ ...CORRETOR_SEM_TOOLS, toolResults: resultado }))
      .toContain('<dados_do_sistema origem="listar_negocios" itens="3">');
  });
  it("Max: sem atributo novo", () => {
    expect(buildSystemPrompt({ ...CORRETOR_SEM_TOOLS, toolResults: resultado }))
      .toContain('<dados_do_sistema origem="listar_negocios">');
  });
});

describe("resposta de falha do modelo", () => {
  it("Newton fala com a equipe interna: sem 'corretor'", () => {
    vi.stubEnv("AGENT_DEPLOY_PROFILE", "newton");
    expect(respostaDeFalha()).toBe("Tive um problema pra responder agora. Tenta de novo em instantes.");
  });
  it("Max: texto de sempre", () => {
    expect(respostaDeFalha()).toBe(
      "Tive um problema pra responder agora. Tenta de novo em instantes, ou fala com seu corretor se for urgente."
    );
  });
});
