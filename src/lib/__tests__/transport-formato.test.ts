import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O ponto único de saída (`sendText`) normaliza o negrito para os dois
 * agentes: Max (Meta) e Newton (bridge) passam pela mesma função.
 */
const enviado = vi.hoisted(() => ({ corpos: [] as string[], interativos: [] as string[] }));

vi.mock("../transport/adapters/log", () => ({
  logAdapter: {
    name: "log",
    capabilities: { templates: false, window24h: false, media: false, groups: false, status: false, typing: false, interactive: true, reactions: false },
    async sendText({ body }: { body: string }) {
      enviado.corpos.push(body);
      return { messageId: "log-1" };
    },
    async sendInteractive({ interativo }: { interativo: { corpo: string } }) {
      enviado.interativos.push(interativo.corpo);
      return { messageId: "log-2" };
    },
  },
}));

const { sendText } = await import("../transport");

beforeEach(() => {
  enviado.corpos.length = 0;
  enviado.interativos.length = 0;
  vi.stubEnv("AGENT_TRANSPORT", "log");
  vi.stubEnv("VERCEL_ENV", "development");
});
afterEach(() => vi.unstubAllEnvs());

describe("sendText normaliza o negrito", () => {
  it("texto: **x** chega como *x*", async () => {
    await sendText({ to: "5511987654321", body: "O **TESTE assinatura 2** está em **Formulário**." });
    expect(enviado.corpos).toEqual(["O *TESTE assinatura 2* está em *Formulário*."]);
  });

  it("interativo: o corpo também", async () => {
    await sendText({
      to: "5511987654321",
      body: "Posso enviar o **contrato**?",
      interativo: { tipo: "botoes", corpo: "Posso enviar o **contrato**?", opcoes: [{ id: "op:SIM", titulo: "SIM" }] },
    });
    expect(enviado.interativos).toEqual(["Posso enviar o *contrato*?"]);
  });
});
