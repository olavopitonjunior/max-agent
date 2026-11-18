import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { catalog } from "@/lib/runtime/catalog";
import { marketingStep } from "../marketing";
const base = {
  orgId: "fixture",
  messageId: "msg-123456",
  now: Date.now(),
  canWrite: true,
  policy: ["marketing.read", "marketing.generate"],
  pending: null,
};
beforeEach(() => {
  vi.stubEnv("MAX_ROLLOUT_ORGS", JSON.stringify({ fixture: ["marketing"] }));
  vi.stubEnv("MAX_MARKETING", "true");
  vi.stubEnv("CONTRACTMAKER_API_URL", "https://staging.imobpro.ia.br");
});
afterEach(() => vi.unstubAllEnvs());
describe("retomada de marketing pelo WhatsApp", () => {
  it("prepara conteúdo educativo sem inventar imóvel nem realizar geração", async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { id: "draft-01", studioPath: "/marketing?draft=draft-01" },
    }));
    const result = await marketingStep(
      { ...base, text: "Crie um carrossel educativo para proprietários" },
      call,
    );
    expect(call).toHaveBeenCalledWith(
      "marketing.draft_create",
      {
        brief: "Crie um carrossel educativo para proprietários",
        format: "carousel",
      },
      base.messageId,
    );
    expect(result?.reply).toContain(
      "https://staging.imobpro.ia.br/marketing?draft=draft-01",
    );
  });
  it("abre o contrato versionado e ignora URLs de terceiros na resposta", async () => {
    const vector = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/contracts/max-marketing-drafts-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).create;
    const call = vi.fn(async () => ({
      status: 200,
      body: { ...vector.response, studioPath: "https://terceiro.invalid" },
    }));
    const result = await marketingStep(
      { ...base, text: vector.args.brief, messageId: vector.idempotencyKey },
      call,
    );
    expect(call).toHaveBeenCalledWith(
      vector.verb,
      vector.args,
      vector.idempotencyKey,
    );
    expect(result?.reply).toContain(vector.response.studioPath);
    expect(result?.reply).not.toContain("terceiro");
    const tool = catalog(base.orgId).tools.find((t) => t.id === vector.verb);
    expect(tool).toMatchObject({
      effect: "write",
      enabled: true,
      permission: "marketing.generate",
    });
  });
  it.each([
    "Retomar rascunho de proposta",
    "Pauta da reunião de amanhã",
    "Veja a imagem do RG",
  ])("não intercepta outros fluxos (%s)", async (text) => {
    const action = vi.fn();
    expect(await marketingStep({ ...base, text }, action)).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
  it.each([
    "Não crie um card educativo",
    "Como criar um card educativo?",
    "Você sabe fazer um card educativo?",
    "Seria interessante um card educativo",
    "Explique como criar um anúncio",
  ])("não cria nem consulta carteira por uma menção: %s", async (text) => {
    const call = vi.fn();
    const result = await marketingStep({ ...base, text }, call);
    expect(result?.pending).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
  it("distingue falha de consulta de carteira vazia", async () => {
    const text = "Crie um card do meu imóvel";
    expect(
      (await marketingStep({ ...base, text }, async () => null))?.event,
    ).toBe("studio_query_failed");
    expect(
      (
        await marketingStep({ ...base, text }, async () => ({
          status: 200,
          body: { items: [] },
        }))
      )?.event,
    ).toBe("studio_no_properties");
  });
  it("aguarda uma seleção explícita mesmo se houver apenas um imóvel", async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { items: [{ id: "property-a" }] },
    }));
    const start = await marketingStep(
      { ...base, text: "Crie um card de um imóvel" },
      call,
    );
    expect(start?.pending?.phase).toBe("studio_property");
    const ambiguous = await marketingStep(
      { ...base, text: "o que eu falei", pending: start!.pending },
      call,
    );
    expect(ambiguous?.pending).toEqual(start?.pending);
    expect(call.mock.calls).toHaveLength(1);
  });
  const oldDraft = "cmwmov30p000xpxtq9p4soxeh";
  const oldDraftLink = "https://staging.imobpro.ia.br/marketing?draft=" + oldDraft;
  it.each([
    "Retome o meu carrossel " + oldDraftLink,
    "Abra o rascunho de marketing pelo ID " + oldDraft,
    "Retomar o rascunho " + oldDraft,
  ])("consulta diretamente uma peça antiga com leitura autorizada: %s", async (text) => {
    const call = vi.fn(async () => ({ status: 200, body: { id: oldDraft, version: 2, studioPath: "https://outro.invalid" } }));
    const result = await marketingStep({ ...base, text, canWrite: false, policy: ["marketing.read"] }, call);
    expect(call.mock.calls).toEqual([["marketing.draft_get", { draftId: oldDraft }]]);
    expect(result?.reply).toContain(oldDraftLink);
    expect(result?.reply).not.toContain("outro.invalid");
    expect(result?.event).toBe("studio_resume");
  });

  it.each([
    "https://outro.invalid/marketing?draft=" + oldDraft,
    "https://staging.imobpro.ia.br/outro?draft=" + oldDraft,
    oldDraftLink + "&draft=outro",
  ])("não consulta um link de estúdio inválido: %s", async (url) => {
    const call = vi.fn();
    const result = await marketingStep({ ...base, text: "Abra o rascunho de marketing " + url }, call);
    expect(call).not.toHaveBeenCalled();
    expect(result?.reply).not.toContain(url);
  });

  it("respeita a política de leitura e a autorização da própria peça", async () => {
    const text = "Retome o rascunho " + oldDraftLink;
    const call = vi.fn(async () => ({ status: 404, body: {} }));
    await marketingStep({ ...base, text, policy: [] }, call);
    expect(call).not.toHaveBeenCalled();
    const denied = await marketingStep({ ...base, text }, call);
    expect(call.mock.calls).toEqual([["marketing.draft_get", { draftId: oldDraft }]]);
    expect(denied?.reply).not.toContain(oldDraft);
    expect(denied?.event).toBe("studio_resume_unavailable");
  });

  it("nega retomada sem política de leitura", async () => {
    const call = vi.fn();
    const result = await marketingStep(
      { ...base, policy: [], text: "Retomar meu rascunho de marketing" },
      call,
    );
    expect(result?.reply).toContain("liberad");
    expect(call).not.toHaveBeenCalled();
  });
});
