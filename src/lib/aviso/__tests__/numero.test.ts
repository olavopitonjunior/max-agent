import { describe, expect, it, vi } from "vitest";
import { payloadDoNumero, type DadosDoNumero, type UltimoAviso } from "../numero";
import { acoesNumeradas } from "../render";
import type { Aviso } from "../schema";

/**
 * Resposta numérica ("2") ao aviso, para quem não tem botão (Newton, Meta com
 * MAX_INTERACTIVE=off). Banco de mentira; o SQL tem teste à parte
 * (`numero.integration.test.ts`).
 */

const AGORA = new Date("2026-10-28T18:00:00Z");
const FONE = "5511987654321";

const BASE: Aviso = {
  v: 1,
  evento: "form_reminder",
  nivel: "B",
  emoji: "⏳",
  titulo: "Formulário aguardando",
  negocio: "Venda Apto 302",
  frase: "O formulário ainda não foi preenchido.",
  itens: [],
  itensExtras: 0,
  link: { rotulo: "Ver formulário", url: "https://trio.imobpro.ia.br/deals/cmx1" },
  acoes: [{ id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }],
  forma: "botoes",
};

function ultimo(over: Partial<UltimoAviso> = {}): UltimoAviso {
  return { id: "row1", audience: "platform_user", sent_at: new Date(AGORA.getTime() - 60 * 60_000), aviso: BASE, ...over };
}

function dados(u: UltimoAviso | null, respondeuDepois = false): DadosDoNumero {
  return {
    ultimoEnviado: vi.fn(async () => u),
    houveRespostaDepois: vi.fn(async () => respondeuDepois),
  };
}

describe("payloadDoNumero", () => {
  it("'2' após aviso com 2 ações: payload da 2ª", async () => {
    expect(await payloadDoNumero(FONE, "2", AGORA, dados(ultimo()))).toBe("av:row1:lembrar_amanha");
  });

  it("'1' é a 1ª; espaços em volta não atrapalham", async () => {
    expect(await payloadDoNumero(FONE, " 1 ", AGORA, dados(ultimo()))).toBe("av:row1:reenviar_link");
  });

  it("'3' com 2 ações: null (segue a conversa normal)", async () => {
    expect(await payloadDoNumero(FONE, "3", AGORA, dados(ultimo()))).toBeNull();
  });

  it.each(["0", "4", "10", "12", "um", "sim", "1 2", "1.", "", "2 pessoas"])("texto %j não é resposta numérica", async (t) => {
    const d = dados(ultimo());
    expect(await payloadDoNumero(FONE, t, AGORA, d)).toBeNull();
    expect(d.ultimoEnviado).not.toHaveBeenCalled();
  });

  it("aviso de 13h atrás: null", async () => {
    const u = ultimo({ sent_at: new Date(AGORA.getTime() - 13 * 60 * 60_000) });
    expect(await payloadDoNumero(FONE, "2", AGORA, dados(u))).toBeNull();
  });

  it("aviso de 11h atrás: ainda vale", async () => {
    const u = ultimo({ sent_at: new Date(AGORA.getTime() - 11 * 60 * 60_000) });
    expect(await payloadDoNumero(FONE, "2", AGORA, dados(u))).toBe("av:row1:lembrar_amanha");
  });

  it("outra resposta do Max depois do aviso: null", async () => {
    const d = dados(ultimo(), true);
    expect(await payloadDoNumero(FONE, "2", AGORA, d)).toBeNull();
    expect(d.houveRespostaDepois).toHaveBeenCalledWith(FONE, expect.any(Date));
  });

  it("sem aviso enviado, sem aviso na linha ou sem ações: null", async () => {
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(null))).toBeNull();
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(ultimo({ aviso: null })))).toBeNull();
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(ultimo({ aviso: { ...BASE, acoes: [] } })))).toBeNull();
  });

  it("parte do negócio nunca tem resposta numérica", async () => {
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(ultimo({ audience: "deal_party" })))).toBeNull();
  });

  it("último envio foi um resumo de rajada (M8): o '1' não é resposta a aviso nenhum", async () => {
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(ultimo({ resumo: true })))).toBeNull();
  });

  it("o número segue o que o TEXTO oferece: ações de link não entram na contagem", async () => {
    const aviso: Aviso = {
      ...BASE,
      acoes: [{ id: "ver_formulario" }, { id: "reenviar_link", alvoId: "f1" }, { id: "lembrar_amanha" }],
    };
    expect(acoesNumeradas(aviso).map((a) => a.id)).toEqual(["reenviar_link", "lembrar_amanha"]);
    expect(await payloadDoNumero(FONE, "1", AGORA, dados(ultimo({ aviso })))).toBe("av:row1:reenviar_link");
    expect(await payloadDoNumero(FONE, "2", AGORA, dados(ultimo({ aviso })))).toBe("av:row1:lembrar_amanha");
    expect(await payloadDoNumero(FONE, "3", AGORA, dados(ultimo({ aviso })))).toBeNull();
  });

  it("lista: a linha escolhida vai pelo alvoId (item), não pelo id da ação repetido", async () => {
    const aviso: Aviso = {
      ...BASE,
      evento: "daily_report",
      forma: "lista",
      acoes: [
        { id: "concluir", alvoId: "atv_1" },
        { id: "concluir", alvoId: "atv_2" },
      ],
    };
    expect(await payloadDoNumero(FONE, "2", AGORA, dados(ultimo({ aviso })))).toBe("av:row1:item:atv_2");
  });
});
