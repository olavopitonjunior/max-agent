import { describe, expect, it } from "vitest";
import { renderQueryOptions } from "@/graph/query-options";
import { derivarInterativo } from "../interativo";
import { newtonBridgeAdapter } from "../transport/adapters/newton-bridge";
import { logAdapter } from "../transport/adapters/log";
import { metaAdapter } from "../transport/adapters/meta";

const ids = (i: ReturnType<typeof derivarInterativo>) => i?.opcoes.map((o) => o.id);

describe("derivarInterativo — menu numerado vira lista", () => {
  it("menu de etapas: 0, as da página e MAIS; corpo sem as linhas de opção", () => {
    const texto = renderQueryOptions({
      subjectKey: "s",
      createdAt: 0,
      options: ["Formulário", "Em contrato", "Enviado para assinatura", "Assinado"],
      offset: 0,
    });
    const i = derivarInterativo(texto);
    expect(i?.tipo).toBe("lista");
    expect(ids(i)).toEqual(["op:0", "op:1", "op:2", "op:3", "op:MAIS"]);
    expect(i?.corpo).toBe("Qual etapa deseja consultar? Responda com o número.");
    expect(i?.tipo === "lista" && i.botao).toBe("Ver opções");
  });

  it("página seguinte numera pelo offset — o toque vale o número que a pessoa digitaria", () => {
    const texto = renderQueryOptions({ subjectKey: "s", createdAt: 0, options: ["A", "B", "C", "D"], offset: 3 });
    expect(ids(derivarInterativo(texto))).toEqual(["op:0", "op:4"]);
  });

  it("rótulo longo: título cortado em 24, descrição com o rótulo até 72", () => {
    const longo = "Proposta PROP-2026-0027 — Rua das Flores, 123, apto 45";
    const i = derivarInterativo(`Qual proposta?\n1. ${longo}\n2. Outra\n\nResponda com o número.`);
    const [primeira, segunda] = i!.opcoes;
    expect(primeira.titulo).toHaveLength(24);
    expect(primeira.titulo.endsWith("…")).toBe(true);
    expect(primeira.descricao).toBe(longo);
    expect(segunda).toEqual({ id: "op:2", titulo: "Outra" });
    expect(i!.corpo).toBe("Qual proposta?\n\nResponda com o número.");
  });

  it("mais de 10 linhas, lista quebrada ou sem pedir número: fica em texto", () => {
    const onze = Array.from({ length: 11 }, (_, k) => `${k + 1}. Item ${k + 1}`).join("\n");
    expect(derivarInterativo(`Escolha:\n${onze}\nResponda com o número.`)).toBeNull();
    expect(derivarInterativo("Escolha:\n1. A\ntexto no meio\n2. B\nResponda com o número.")).toBeNull();
    expect(derivarInterativo("Seus negócios:\n1. A\n2. B")).toBeNull();
    expect(derivarInterativo("Escolha:\n1. Só um\nResponda com o número.")).toBeNull();
  });
});

describe("derivarInterativo — Responda SIM vira botões", () => {
  it("SIM e NÃO quando o texto oferece os dois", () => {
    const i = derivarInterativo("Posso concluir a atividade?\n\nResponda SIM para confirmar ou NÃO para parar.");
    expect(i?.tipo).toBe("botoes");
    expect(ids(i)).toEqual(["op:SIM", "op:NÃO"]);
    expect(i?.corpo).toBe("Posso concluir a atividade?\n\nResponda SIM para confirmar ou NÃO para parar.");
  });

  it("só SIM quando a alternativa é texto livre (\"ou me diga o que mudar\")", () => {
    expect(ids(derivarInterativo("Atualizo o rascunho assim? Responda *SIM*, ou me diga o que mais mudar."))).toEqual(["op:SIM"]);
  });

  it("CANCELAR quando é ele que o texto oferece", () => {
    expect(ids(derivarInterativo("Antes, preciso conferir: responda *SIM* (não duplica) ou CANCELAR."))).toEqual(["op:SIM", "op:CANCELAR"]);
  });

  it("\"não\" minúsculo é prosa, não botão", () => {
    expect(ids(derivarInterativo("Responda SIM para verificar o mesmo pedido, sem repeti-lo. Isso não duplica."))).toEqual(["op:SIM"]);
  });

  it.each([
    ["Negar a autorização? Responda *sim* (ou *não*).", ["op:SIM", "op:NÃO"]],
    ["Confirma? (responda *sim*/*não*.)", ["op:SIM", "op:NÃO"]],
    ["Posso? Responda sim ou não.", ["op:SIM", "op:NÃO"]],
    ["Responda *sim* para eu pedir a autorização, ou *não* para deixar como está.", ["op:SIM", "op:NÃO"]],
    ["Responda *sim* para eu conferir — não duplica — ou CANCELAR.", ["op:SIM", "op:CANCELAR"]],
    ["Responda SIM para eu tentar de novo: os valores são os mesmos, então não duplica nada.", ["op:SIM"]],
    ["Responda *sim* (ou CANCELAR).", ["op:SIM", "op:CANCELAR"]],
  ])("frase real do grafo: %s", (texto, esperado) => {
    expect(ids(derivarInterativo(texto))).toEqual(esperado);
  });

  it("instrução para terceiro (peça que ele responda SIM) não vira botão", () => {
    expect(derivarInterativo("Quando o cliente receber, peça que ele responda SIM no WhatsApp da ClickSign.")).toBeNull();
  });

  it("corpo acima de 1024: fica em texto", () => {
    expect(derivarInterativo(`${"x".repeat(1100)}\n\nResponda SIM.`)).toBeNull();
  });

  it("texto comum, vazio ou nulo: nada", () => {
    expect(derivarInterativo("Você tem 3 negócios em contrato.")).toBeNull();
    expect(derivarInterativo("")).toBeNull();
    expect(derivarInterativo(null)).toBeNull();
  });
});

describe("quem sabe mostrar botão", () => {
  it("só a Meta: Newton (bridge) e log recebem o texto numerado", () => {
    expect(metaAdapter.capabilities.interactive).toBe(true);
    expect(newtonBridgeAdapter.capabilities.interactive).toBe(false);
    expect(newtonBridgeAdapter.sendInteractive).toBeUndefined();
    expect(logAdapter.capabilities.interactive).toBe(false);
  });
});
