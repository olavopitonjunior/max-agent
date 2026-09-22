import { describe, expect, it } from "vitest";
import {
  classificarMeta,
  falhaDaMensagemMeta,
  inoperanciaDoErro,
  MetaHttpError,
} from "../transport/erro";
import { ZapiHttpError } from "../zapi-erro";

const metaErro = (status: number, code: number) =>
  new MetaHttpError("/123/messages", status, JSON.stringify({ error: { code, message: "m" } }));

describe("MetaHttpError", () => {
  it("extrai o código do corpo; corpo não-JSON fica sem código", () => {
    expect(metaErro(401, 190).code).toBe(190);
    expect(metaErro(401, 190).message).toContain("(#190)");
    expect(new MetaHttpError("/x", 502, "<html>bad gateway</html>").code).toBeNull();
  });
});

describe("classificarMeta — o CANAL recusando", () => {
  it("token e permissão são credencial", () => {
    for (const c of [0, 3, 10, 190, 200, 131005]) expect(classificarMeta(c)).toBe("credencial");
  });
  it("forma de pagamento é assinatura", () => {
    expect(classificarMeta(131042)).toBe("assinatura");
  });
  it("conta restrita e número fora do registro são número", () => {
    for (const c of [368, 131031, 131045, 133010]) expect(classificarMeta(c)).toBe("numero");
  });
  /**
   * Conservador: inoperância REPRESA a fila inteira. Um erro de mensagem
   * classificado como canal pararia todas as notificações por causa de uma.
   */
  it("erro de mensagem, limite e desconhecido NÃO são inoperância", () => {
    for (const c of [131047, 131026, 132001, 130429, 131056, 131000, 1, 100]) {
      expect(classificarMeta(c)).toBeNull();
    }
    expect(classificarMeta(null)).toBeNull();
  });
});

describe("falhaDaMensagemMeta", () => {
  it("131047 pede template; 130429/131048/131056 são limite", () => {
    expect(falhaDaMensagemMeta(metaErro(400, 131047))).toBe("requer_template");
    for (const c of [130429, 131048, 131056]) expect(falhaDaMensagemMeta(metaErro(429, c))).toBe("limite");
  });
  it("outro erro, erro sem código ou erro que não é da Meta: null", () => {
    expect(falhaDaMensagemMeta(metaErro(400, 131026))).toBeNull();
    expect(falhaDaMensagemMeta(new MetaHttpError("/x", 500, ""))).toBeNull();
    expect(falhaDaMensagemMeta(new Error("x"))).toBeNull();
  });
});

describe("inoperanciaDoErro — os dois provedores", () => {
  it("Meta: canal recusando vira inoperância com motivo e detalhe", () => {
    expect(inoperanciaDoErro(metaErro(401, 190))).toMatchObject({ motivo: "credencial" });
    expect(inoperanciaDoErro(metaErro(403, 368))).toMatchObject({ motivo: "numero" });
    expect(inoperanciaDoErro(metaErro(402, 131042))?.detalhe).toContain("#131042");
    expect(inoperanciaDoErro(metaErro(400, 131047))).toBeNull();
  });
  it("Z-API continua como era", () => {
    expect(inoperanciaDoErro(new ZapiHttpError("/send-text", 400, "you must subscribe"))).toMatchObject({
      motivo: "assinatura",
    });
    expect(inoperanciaDoErro(new ZapiHttpError("/send-text", 500, "x"))).toBeNull();
  });
  it("erro genérico não é inoperância", () => {
    expect(inoperanciaDoErro(new Error("timeout"))).toBeNull();
  });
});
