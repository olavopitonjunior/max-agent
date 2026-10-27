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
      const p = buildSystemPrompt({ ...entrada, pendencias: true }).replace(/\s+/g, " ");
      expect(p).toContain("diga sempre o total exato de cada bloco");
      expect(p).toContain("no máximo 5 itens por bloco");
      expect(p).toContain("pergunta genérica = formulários, propostas e atividades");
      expect(p).toContain("pergunta específica = só o bloco pedido");
      expect(p).toContain("os itens de dentro de cada formulário já vêm limitados");
      expect(p).toContain("sem_permissao");
    }
  });
});

/**
 * Pendências e avisos só entram no prompt de quem tem a capability (`pending.summary`, `prefs.self`).
 * Sem nenhuma das duas, nenhum trecho de pendências ou avisos aparece (os snapshots acima já
 * incluem o bloco fixo "como falar de status"); cada trecho abaixo só aparece com a sua flag.
 */
describe("trechos condicionais do prompt", () => {
  const entradas = [CORRETOR_SEM_TOOLS, GERENTE_COM_LEITURA, DESCONHECIDO];
  const achatar = (t: string) => t.replace(/\s+/g, " ");

  it("sem pending.summary nem prefs.self: nenhum trecho de pendências ou avisos", () => {
    for (const entrada of entradas) {
      const p = achatar(buildSystemPrompt(entrada));
      expect(p).not.toContain("Ao listar pendências");
      expect(p).not.toContain("o que está pendente com você");
      expect(p).not.toContain("avisos da própria pessoa");
      // explícito: as duas flags desligadas são o mesmo que omitidas
      expect(buildSystemPrompt({ ...entrada, pendencias: false, avisos: false })).toBe(buildSystemPrompt(entrada));
    }
  });

  it("pending.summary liga só o trecho de pendências", () => {
    for (const entrada of entradas) {
      const p = achatar(buildSystemPrompt({ ...entrada, pendencias: true }));
      expect(p).toContain("Ao listar pendências, diga sempre o total exato");
      expect(p).toContain('o que está pendente com você": formulários, propostas e atividades)');
      expect(p).not.toContain("avisos da própria pessoa");
    }
  });

  it("status por papel (27/10/2026): 'como falar de status' vale para todos; o responsável do item, só com pendências", () => {
    for (const entrada of entradas) {
      const sem = achatar(buildSystemPrompt(entrada));
      expect(sem).toContain("Ao falar de negócio, proposta ou captação de outra pessoa da equipe, diga quem é o responsável pelo nome");
      expect(sem).toContain('Descreva o fato em linguagem simples ("o negócio X avançou para Y"), sem jargão como "mudança de etapa".');
      expect(sem).not.toContain("Quando o item trouxer responsável");
      const com = achatar(buildSystemPrompt({ ...entrada, pendencias: true }));
      expect(com).toContain('Quando o item trouxer responsável, cite junto do item: "· Ana (Equipe Centro · Vendas)".');
    }
  });

  it("prefs.self liga só o trecho de avisos", () => {
    for (const entrada of entradas) {
      const p = achatar(buildSystemPrompt({ ...entrada, avisos: true }));
      expect(p).toContain("consulta de negócios e pendências e os avisos da própria pessoa (relatório da manhã, lembrete antes do vencimento) — e, dentro disso");
      expect(p).toContain("Só fala de propostas, negócios, dos avisos da própria pessoa e do processo da imobiliária.");
      expect(p).not.toContain("Ao listar pendências");
    }
  });

  it("as duas ligadas: os dois trechos, na ordem certa", () => {
    const p = achatar(buildSystemPrompt({ ...GERENTE_COM_LEITURA, pendencias: true, avisos: true }));
    expect(p).toContain('consulta de negócios e pendências (inclusive "o que está pendente com você": formulários, propostas e atividades) e os avisos da própria pessoa');
  });
});
