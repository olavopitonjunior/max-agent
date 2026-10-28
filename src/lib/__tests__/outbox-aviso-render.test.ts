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

  it("Meta (interativo) com MAX_INTERACTIVE=off: modo numerado, mas sem Responda até existir o roteador", () => {
    vi.stubEnv("MAX_INTERACTIVE", "off");
    const out = renderMessage({ ...LINHA, aviso: AVISO });
    // Sem roteador das respostas numeradas ainda, o bloco "Responda" não sai.
    expect(out).not.toContain("Responda:");
    expect(out).toContain("👉 Abrir negócio:");
  });

  it("Meta com MAX_INTERACTIVE ligado: modo interativo, sem bloco Responda", () => {
    expect(renderMessage({ ...LINHA, aviso: AVISO })).not.toContain("Responda:");
  });

  it("transporte sem interativo (log): modo numerado, sem Responda", () => {
    vi.stubEnv("AGENT_TRANSPORT", "log");
    const out = renderMessage({ ...LINHA, aviso: AVISO });
    // Sem roteador das respostas numeradas ainda, o bloco "Responda" não sai.
    expect(out).not.toContain("Responda:");
    expect(out).toContain("👉 Abrir negócio:");
  });

  it("aviso nulo: formato de hoje, com a assinatura em itálico escapado", () => {
    expect(renderMessage({ ...LINHA, aviso: null })).toBe(
      "Oi, Ana! *Formulário aguardando*\n\ncorpo antigo\n\nhttps://x.test/d\n\n_RE/MAX Trio_"
    );
  });
});
