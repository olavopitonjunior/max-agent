import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Aviso } from "../aviso/schema";

vi.mock("../db", () => ({ query: vi.fn(), db: vi.fn() }));

const { renderMessage } = await import("../outbox");

const AVISO: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário de *Venda Apto 302* ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Abrir negócio", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link" }, { id: "lembrar_amanha" }, { id: "ver_formulario" }],
  forma: "botoes",
};

const LINHA = {
  title: "Formulário aguardando",
  body: "corpo antigo",
  link_url: "https://x.test/d",
  org_name: "RE/MAX Trio",
  recipient_name: "Ana Souza",
};

// Sem mock do transporte: o `modo` vem do adapter real + kill switch MAX_INTERACTIVE.
beforeEach(() => {
  vi.stubEnv("AGENT_TRANSPORT", "");
  vi.stubEnv("MAX_INTERACTIVE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("renderMessage com aviso", () => {
  it("delega ao renderAvisoTexto; link no texto (sem botão ainda)", () => {
    const out = renderMessage({ ...LINHA, aviso: AVISO });
    expect(out.startsWith("Oi, Ana! ⏳ *Formulário aguardando*")).toBe(true);
    expect(out).toContain("👉 Abrir negócio: https://trio.imobpro.ia.br/deals/cmx1");
    expect(out).toContain("_RE/MAX Trio_");
    expect(out).not.toContain("corpo antigo");
    expect(out).not.toContain("Responda:");
  });

  it("Meta (interativo) com MAX_INTERACTIVE=off: modo numerado, com Responda (o roteador do número existe)", () => {
    vi.stubEnv("MAX_INTERACTIVE", "off");
    const out = renderMessage({ ...LINHA, aviso: AVISO });
    expect(out).toContain("Responda:\n*1* · reenviar link\n*2* · lembrar amanhã");
    expect(out).not.toContain("*3*");
    expect(out).toContain("👉 Abrir negócio:");
  });

  it("Meta com MAX_INTERACTIVE ligado: modo interativo, sem bloco Responda", () => {
    expect(renderMessage({ ...LINHA, aviso: AVISO })).not.toContain("Responda:");
  });

  it("transporte sem interativo (log): modo numerado, com Responda", () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    const out = renderMessage({ ...LINHA, aviso: AVISO });
    expect(out).toContain("Responda:\n*1* · reenviar link\n*2* · lembrar amanhã");
    expect(out).toContain("👉 Abrir negócio:");
  });

  describe("decisão da proposta (proposal_awaiting_decision)", () => {
    const DECISAO = {
      ...LINHA,
      kind: "proposal_awaiting_decision",
      title: "Proponente assinou",
      body: "O proponente assinou. Decida: enviar a 2ª via ao proprietário ou concluir sem enviar. https://x.test/p/cmx1",
      link_url: "https://x.test/p/cmx1",
      aviso: null,
    };
    const PERGUNTA = "Proposta PROP-2026-0031: Responda ENVIAR para mandar ao proprietário ou ENCERRAR para concluir.";

    it("sem o fato decisao (CM antigo): texto idêntico ao de antes", () => {
      const out = renderMessage({ ...DECISAO, params: { proposta: "PROP-2026-0031 Rua X" } });
      expect(out).not.toContain("Responda ENVIAR");
      expect(out).toBe(`Oi, Ana! *Proponente assinou*\n\n${DECISAO.body}\n\n_RE/MAX Trio_`);
    });

    it("liberar_etapa ou encerrar: não pergunta", () => {
      for (const decisao of ["liberar_etapa", "encerrar"]) {
        const out = renderMessage({ ...DECISAO, params: { codigo: "PROP-2026-0031", decisao } });
        expect(out).not.toContain("Responda ENVIAR");
      }
    });

    it("outro kind com decisao: não pergunta", () => {
      const out = renderMessage({
        ...DECISAO,
        kind: "proposal_signed_all",
        params: { codigo: "PROP-2026-0031", decisao: "enviar_proprietario_ou_encerrar" },
      });
      expect(out).not.toContain("Responda ENVIAR");
    });

    it("com codigo + decisao: a pergunta fixa vem depois do corpo e antes da assinatura da org", () => {
      const out = renderMessage({
        ...DECISAO,
        params: { proposta: "PROP-2026-0031 Rua X", codigo: "PROP-2026-0031", decisao: "enviar_proprietario_ou_encerrar" },
      });
      expect(out).toBe(`Oi, Ana! *Proponente assinou*\n\n${DECISAO.body}\n\n${PERGUNTA}\n\n_RE/MAX Trio_`);
    });
  });

  it("aviso nulo: formato de hoje, com a assinatura em itálico escapado", () => {
    expect(renderMessage({ ...LINHA, aviso: null })).toBe(
      "Oi, Ana! *Formulário aguardando*\n\ncorpo antigo\n\nhttps://x.test/d\n\n_RE/MAX Trio_"
    );
  });
});
