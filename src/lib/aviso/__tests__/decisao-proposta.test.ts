import { describe, expect, it } from "vitest";
import { codigoDaProposta, perguntaDaDecisao, PERGUNTA_ENVIAR_OU_ENCERRAR } from "../decisao-proposta";

const KIND = "proposal_awaiting_decision";
const DECISAO = "enviar_proprietario_ou_encerrar";

describe("perguntaDaDecisao", () => {
  it("outro kind: sem pergunta", () => {
    expect(perguntaDaDecisao("proposal_signed_all", { codigo: "PROP-2026-0031", decisao: DECISAO })).toBeNull();
    expect(perguntaDaDecisao(null, { codigo: "PROP-2026-0031", decisao: DECISAO })).toBeNull();
    expect(perguntaDaDecisao(undefined, { codigo: "PROP-2026-0031", decisao: DECISAO })).toBeNull();
  });

  it("sem params, sem decisao ou com outra decisao: sem pergunta (fail-closed)", () => {
    expect(perguntaDaDecisao(KIND, null)).toBeNull();
    expect(perguntaDaDecisao(KIND, undefined)).toBeNull();
    expect(perguntaDaDecisao(KIND, { codigo: "PROP-2026-0031" })).toBeNull();
    expect(perguntaDaDecisao(KIND, { codigo: "PROP-2026-0031", decisao: "encerrar" })).toBeNull();
    expect(perguntaDaDecisao(KIND, { codigo: "PROP-2026-0031", decisao: "liberar_etapa" })).toBeNull();
  });

  it("código ausente ou inválido: sem pergunta", () => {
    expect(perguntaDaDecisao(KIND, { decisao: DECISAO })).toBeNull();
    expect(perguntaDaDecisao(KIND, { codigo: "qualquer coisa", decisao: DECISAO })).toBeNull();
    expect(perguntaDaDecisao(KIND, { proposta: "Rua X sem código", decisao: DECISAO })).toBeNull();
  });

  it("com kind, decisao e código: pergunta fixa com o código", () => {
    expect(perguntaDaDecisao(KIND, { codigo: "PROP-2026-0031", decisao: DECISAO })).toBe(
      `Proposta PROP-2026-0031: ${PERGUNTA_ENVIAR_OU_ENCERRAR}`
    );
  });

  it("sem `codigo`, cai no primeiro termo de `proposta`", () => {
    expect(perguntaDaDecisao(KIND, { proposta: "prop-2026-0031 Rua X, 10", decisao: DECISAO })).toBe(
      `Proposta PROP-2026-0031: ${PERGUNTA_ENVIAR_OU_ENCERRAR}`
    );
  });
});

describe("codigoDaProposta", () => {
  it("`codigo` vale mais que `proposta`", () => {
    expect(codigoDaProposta({ codigo: "PROP-2026-0001", proposta: "PROP-2026-0002 x" })).toBe("PROP-2026-0001");
  });

  it("nada reconhecível: null", () => {
    expect(codigoDaProposta(null)).toBeNull();
    expect(codigoDaProposta({})).toBeNull();
    expect(codigoDaProposta({ codigo: "PROP-26-1x" })).toBeNull();
  });
});
