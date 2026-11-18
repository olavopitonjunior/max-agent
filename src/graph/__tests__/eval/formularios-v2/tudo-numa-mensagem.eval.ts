import { afterEach, describe, expect, it } from "vitest";
import { CPF_SINTETICO, ModeloFalso, ServidorFalso, Sessao, verificarTransversais } from "./harness";

/**
 * Tudo numa mensagem: nome, CPF, telefone e valor chegam juntos. O modelo recebe o texto com TOKENS
 * (nunca o CPF), devolve os campos com tokens e o agente destokeniza. A resposta é a ficha com os
 * valores; só o "sim" depois da ficha grava.
 */
describe("eval fv2: tudo numa mensagem", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("extrai, mostra a ficha, grava só no sim e deixa o rascunho completo", async () => {
    const modelo = new ModeloFalso().roteiro(({ tokens }) => ({
      compradores: [{ nome: "Ricardo Almeida Teste", cpf: tokens.CPF[0], telefone: tokens.TEL[0] }],
      negociacao: { valor: 500000 },
    }));
    s = new Sessao({ modelo, servidor: new ServidorFalso(), nomes: ["Ricardo Almeida Teste"], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();

    const t1 = await s.fala(
      "Comprador Ricardo Almeida Teste, CPF 529.982.247-25, telefone (11) 90000-0011, valor R$ 500.000 à vista, pode montar a ficha"
    );
    // A ficha mostra o que foi lido (CPF e telefone mascarados), pede o SIM e NÃO diz que anotou.
    expect(t1.sensivel).toBe(true);
    expect(t1.reply).toContain("Ricardo Almeida Teste");
    expect(t1.reply).toContain("***.982.247-**");
    expect(t1.reply).not.toContain("529.982.247-25");
    expect(t1.reply).toMatch(/responda SIM/i);
    // Nada foi escrito antes do "sim": o único contato com o servidor foi leitura.
    expect(s.servidor.escritas()).toHaveLength(0);
    expect(s.servidor.rascunho).toBeNull();
    // Um único modelo no turno (a extração) e o custo reportado.
    expect(s.modelo.extracoesFeitas).toBe(1);

    const t2 = await s.fala("sim");
    expect(s.servidor.escritasDoVerbo("proposal.create")).toHaveLength(1);
    expect(t2.escritas[0]?.idempotencyKey).toBe(t2.messageId);
    expect(t2.reply).toMatch(/anotei e salvei no rascunho PROP-2026-0001/i);

    // Estado final do rascunho no servidor.
    const r = s.servidor.rascunho!;
    expect(r.schemaType).toBe("compra_venda_v1");
    expect(r.compradores).toHaveLength(1);
    expect(r.compradores[0]).toMatchObject({ nome: "Ricardo Almeida Teste", cpf: CPF_SINTETICO });
    expect(String(r.compradores[0]!.telefone).replace(/\D/g, "")).toBe("11900000011");
    expect(r.negociacao.valor).toBe(500000);
    expect(s.servidor.faltando()).toEqual([]);
    // Nada foi enviado para assinatura sem pedido.
    expect(s.servidor.escritasDoVerbo("proposal.send")).toHaveLength(0);
  });
});
