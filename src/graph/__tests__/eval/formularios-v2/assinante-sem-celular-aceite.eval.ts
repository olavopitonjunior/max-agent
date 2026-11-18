import { afterEach, describe, expect, it } from "vitest";
import { ModeloFalso, PESSOAS, ServidorFalso, Sessao, telefoneFicticio, verificarTransversais } from "./harness";

/**
 * Assinante sem celular com Aceite (PR-D/PR-A). Documenta o que já está implementado: a lista avisa quem
 * falta, a escolha do Aceite NÃO grava e não pede o celular pelo chat (o agente não consegue conferir de
 * quem é o número no rascunho), e o corretor segue com outro tipo ou completa pela tela do sistema.
 */
describe("eval fv2: assinante sem celular com Aceite", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  async function abrir(bot: "max" | "newton"): Promise<void> {
    const servidor = new ServidorFalso();
    servidor.rascunho = {
      id: "prop-1",
      codigo: "PROP-2026-0001",
      schemaType: "compra_venda_v1",
      compradores: [{ nome: PESSOAS.comprador }],
      vendedores: [],
      imovel: {},
      negociacao: { valor: 500000 },
      corretor: {},
    };
    servidor.assinantesSemCelular = [{ posicao: 1, papel: "proponente", nome: PESSOAS.comprador }];
    s = new Sessao({ bot, servidor, modelo: new ModeloFalso(), nomes: [PESSOAS.comprador] });
    await s.preparar();
  }

  it.each(["max", "newton"] as const)("%s: a lista avisa quem falta e o Aceite não grava nem pede o celular", async (bot) => {
    await abrir(bot);

    const t1 = await s.fala("enviar PROP-2026-0001 para assinatura");
    expect(t1.reply).toContain("Aceite no celular");
    expect(t1.reply).toContain(`falta o celular de ${PESSOAS.comprador}`);
    expect(t1.escritas).toHaveLength(0);

    const t2 = await s.fala("aceite");
    expect(t2.reply).toContain(`falta o celular de *${PESSOAS.comprador}*`);
    expect(t2.reply).toContain("não gravei nada");
    expect(t2.reply).not.toMatch(/Qual (é )?o celular/i);
    expect(t2.escritas).toHaveLength(0);
    expect(s.servidor.escritasDoVerbo("proposal.update")).toHaveLength(0);
    expect(s.servidor.escritasDoVerbo("proposal.send")).toHaveLength(0);
  });

  it("um número digitado no chat não vira celular do assinante (nada é escrito)", async () => {
    await abrir("max");
    await s.fala("enviar PROP-2026-0001 para assinatura");
    await s.fala("aceite");

    const t = await s.fala(`o celular dele é ${telefoneFicticio(11)}`);
    expect(t.escritas).toHaveLength(0);
    expect(s.servidor.rascunho?.compradores[0]).not.toHaveProperty("telefone");
  });

  it("escolher outro tipo segue: confere, pede o sim e só então envia", async () => {
    await abrir("max");
    await s.fala("enviar PROP-2026-0001 para assinatura");
    await s.fala("aceite");

    const t3 = await s.fala("e-mail");
    expect(t3.reply).toContain("Antes de enviar, confira");
    expect(t3.reply).toMatch(/Responda \*SIM\*/);
    expect(s.servidor.escritasDoVerbo("proposal.send")).toHaveLength(0);

    const t4 = await s.fala("sim");
    expect(t4.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.send", 200]]);
    expect(t4.escritas[0]!.args).toMatchObject({ proposta_id: "prop-1", instrumento_confirmado: "envelope", tipo_assinatura: "email" });
    expect(t4.reply).toMatch(/enviada para assinatura/i);
  });
});
