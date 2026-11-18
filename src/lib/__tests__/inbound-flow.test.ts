import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionsV2 } from "../../graph/formularios/contrato";
import { derivarInterativo } from "../interativo";
import { descartarFlowDoTurno, montarEnvioDoFlow, registrarFlowDoTurno, VALIDADE_DO_CANAL_MS } from "../meta-flow";

// inbound.ts importa o grafo e o banco; aqui só importa a função pura de montar o envio.
vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("@/graph/graph", () => ({ runTurn: vi.fn() }));

const { comInterativo } = await import("../inbound");

/**
 * `comInterativo` roda em TODO envio, v1 inclusive (I3). Negados primeiro: sem Flow registrado o
 * resultado é idêntico ao `derivarInterativo` de antes; com texto diferente do registrado, o Flow
 * não sai; depois do envio, a entrada some.
 */

const ENV = { MAX_FLOW_ID_REVISAR_PARTES: "FLOW_PARTES" } as unknown as NodeJS.ProcessEnv;

const options = {
  metodos: [],
  signatarios: [{ nome: "Maria Souza", papel: "comprador" }],
  assinaturaConfigurada: true,
  modalidades: [],
  obrigatorios: [{ chave: "proponente.nome", rotulo: "Nome do comprador", grupo: "Partes", esteira: "venda", tipoCampo: "texto" }],
  tiposDeAssinatura: [],
  fluxoV2: true,
} as unknown as OptionsV2;

const CORPO = "Revisão da proposta PROP-1\n1. Comprador 1 · Nome do comprador ✅";

function flow() {
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
  vi.stubEnv("MAX_INTERACTIVE", "");
  vi.stubEnv("MAX_FLOW_ID_REVISAR_PARTES", "FLOW_PARTES");
  const f = montarEnvioDoFlow("partes", options, {}, CORPO, "NONCE", ENV);
  if (!f) throw new Error("Flow não montou");
  return f;
}

beforeEach(() => {
  vi.stubEnv("AGENT_DEPLOY_PROFILE", "max");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("comInterativo", () => {
  it("sem registro no canal lateral: idêntico ao derivarInterativo de sempre", () => {
    const menu = "Qual deles?\nResponda com o número:\n1. Casa\n2. Apartamento";
    expect(comInterativo(menu, "wamid.SEM")).toEqual({ interativo: derivarInterativo(menu) });
    expect(comInterativo("Oi, tudo bem?", "wamid.SEM")).toEqual({});
    expect(comInterativo(menu)).toEqual({ interativo: derivarInterativo(menu) });
    expect(comInterativo("Oi", undefined)).toEqual({});
  });

  it("registro com texto diferente do que vai sair: o Flow NÃO é usado (negado)", () => {
    registrarFlowDoTurno("wamid.DIF", flow());
    expect(comInterativo("Outra resposta qualquer do grafo", "wamid.DIF")).toEqual({});
    descartarFlowDoTurno("wamid.DIF");
  });

  it("registro de outra mensagem não vaza para esta", () => {
    registrarFlowDoTurno("wamid.A", flow());
    expect(comInterativo(CORPO, "wamid.B")).toEqual({});
    descartarFlowDoTurno("wamid.A");
  });

  it("registro com o mesmo texto: sai o Flow", () => {
    const f = flow();
    registrarFlowDoTurno("wamid.OK", f);
    expect(comInterativo(CORPO, "wamid.OK")).toEqual({ interativo: f });
    descartarFlowDoTurno("wamid.OK");
  });

  it("depois de enviado (descartado), a retentativa não reenvia o Flow", () => {
    registrarFlowDoTurno("wamid.RET", flow());
    descartarFlowDoTurno("wamid.RET");
    expect(comInterativo(CORPO, "wamid.RET")).toEqual({});
  });

  it("entrada vencida não é usada", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
      registrarFlowDoTurno("wamid.VEL", flow());
      vi.setSystemTime(new Date(Date.now() + VALIDADE_DO_CANAL_MS + 1_000));
      expect(comInterativo(CORPO, "wamid.VEL")).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
