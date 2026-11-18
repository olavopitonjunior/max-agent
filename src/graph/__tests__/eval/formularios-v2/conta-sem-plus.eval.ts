import { afterEach, describe, expect, it } from "vitest";
import { ModeloFalso, PESSOAS, ServidorFalso, Sessao, verificarTransversais } from "./harness";

/**
 * Conta sem Plus (PR-D): o servidor marca o WhatsApp como indisponível (`plano_sem_plus`). A lista some
 * com a opção, escolhê-la é recusado sem gravar e sem preflight, e o Aceite (que não depende do Plus)
 * continua disponível, com confirmação explícita antes de gravar o canal.
 */
describe("eval fv2: conta sem Plus", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  async function abrir(bot: "max" | "newton"): Promise<void> {
    const servidor = new ServidorFalso({
      tiposDeAssinatura: [
        { tipo: "email", disponivel: true, texto: "E-mail" },
        { tipo: "whatsapp", disponivel: false, motivo: "plano_sem_plus", texto: "WhatsApp" },
        { tipo: "aceite", disponivel: true, custoCentavos: 99, texto: "Aceite" },
      ],
    });
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
    s = new Sessao({ bot, servidor, modelo: new ModeloFalso(), nomes: [PESSOAS.comprador] });
    await s.preparar();
  }

  it.each(["max", "newton"] as const)("%s: a lista não oferece WhatsApp", async (bot) => {
    await abrir(bot);
    const t = await s.fala("enviar PROP-2026-0001 para assinatura");
    expect(t.reply).toMatch(/Por e-mail/i);
    expect(t.reply).toContain("Aceite no celular");
    expect(t.reply).not.toMatch(/Por WhatsApp/i);
    expect(t.escritas).toHaveLength(0);
  });

  it("pedir WhatsApp é recusado, sem gravar canal e sem conferência de envio", async () => {
    await abrir("max");
    await s.fala("enviar PROP-2026-0001 para assinatura");

    const t = await s.fala("whatsapp");
    expect(t.reply).toContain("Esse tipo de assinatura não está disponível para esta proposta.");
    expect(t.escritas).toHaveLength(0);
    expect(s.servidor.escritasDoVerbo("proposal.preflight")).toHaveLength(0);
    expect(s.servidor.escritasDoVerbo("proposal.update")).toHaveLength(0);
    expect(s.servidor.escritasDoVerbo("proposal.send")).toHaveLength(0);
  });

  it("o Aceite segue disponível: grava o canal só no sim, confere e envia só no segundo sim", async () => {
    await abrir("max");
    await s.fala("enviar PROP-2026-0001 para assinatura");

    const t2 = await s.fala("aceite");
    expect(t2.reply).toMatch(/Responda \*SIM\* para gravar/);
    expect(t2.escritas).toHaveLength(0);

    const t3 = await s.fala("sim");
    expect(t3.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.update", 200]]);
    expect(t3.escritas[0]!.args).toMatchObject({ proposta_id: "prop-1", tipo_assinatura: "aceite" });
    expect(t3.reply).toContain("Antes de enviar, confira");
    expect(s.servidor.escritasDoVerbo("proposal.send")).toHaveLength(0);

    const t4 = await s.fala("sim");
    expect(t4.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.send", 200]]);
    expect(t4.escritas[0]!.args).toMatchObject({ proposta_id: "prop-1", instrumento_confirmado: "aceite", tipo_assinatura: "aceite" });
  });
});
