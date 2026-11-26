import { describe, expect, it, vi } from "vitest";

/**
 * Polimento da proposta (E2E de prod 19/11, org Fincasa, dados "TESTE"):
 *  1. bairro gravado como a cidade ("São Paulo");
 *  2. o extrator tirava o "TESTE" do nome da pessoa;
 *  4. no cartão de envio, o pedido de trocar o tipo de assinatura era ignorado.
 */

const F = await import("../fluxos");
type Fluxo = import("../fluxos").Fluxo;
type DadosDaProposta = import("../fluxos").DadosDaProposta;

const agora = 1_000_000;
const TUDO = ["proposal.create", "proposal.send", "form.create"] as const;
const ctx = (texto: string) => ({ texto, messageId: `m-${texto.slice(0, 8)}`, policy: [...TUDO], agora });
function deps(over: Partial<import("../fluxos").DepsDoFluxo> = {}) {
  return { acao: vi.fn().mockResolvedValue(null), extrairProposta: vi.fn().mockResolvedValue({}), extrairCampos: vi.fn().mockResolvedValue({}), ...over };
}

describe("1. bairro nunca é a cidade", () => {
  const dado = (bairro: string, cidade?: string, uf?: string): DadosDaProposta => ({ imovel: { endereco: "Rua Augusta, 100", bairro, cidade, uf } });
  const lido = (d: DadosDaProposta, texto: string) => F.conferirDitado(F.sanearDados(d), texto).imovel;

  it("o schema da tool descreve o bairro e proíbe cidade/estado", () => {
    const bairro = TOOL().parameters.properties.imovel.properties.bairro as { description?: string };
    expect(bairro.description).toMatch(/nunca a cidade nem o estado/);
    expect(bairro.description).toMatch(/omita/i);
  });
  it.each([
    ["bairro igual à cidade", dado("São Paulo", "São Paulo", "SP"), "Rua Augusta, 100, São Paulo/SP"],
    ["bairro igual à cidade sem acento/caixa", dado("sao paulo", "São Paulo", "SP"), "Rua Augusta, 100, São Paulo/SP"],
    ["bairro igual à sigla", dado("SP", "São Paulo", "SP"), "Rua Augusta, 100, São Paulo, SP"],
    ["bairro igual ao estado por extenso", dado("São Paulo", "Campinas", "SP"), "Rua Augusta, 100, Campinas/SP, estado de São Paulo"],
    ["cidade ausente, texto traz 'Cidade/UF'", dado("São Paulo", undefined, "SP"), "Rua Augusta, 100, São Paulo/SP"],
    ["bairro que a pessoa não disse", dado("Pinheiros", "São Paulo", "SP"), "Rua Augusta, 100, São Paulo/SP"],
  ])("descarta: %s", (_n, d, texto) => {
    expect(lido(d, texto)?.bairro).toBeUndefined();
  });
  it.each([
    ["bairro dito no texto", dado("Bela Vista", "São Paulo", "SP"), "Rua Augusta, 100, Bela Vista, São Paulo/SP"],
    ["bairro com acento diferente", dado("Vila São Geraldo", "São Paulo", "SP"), "Rua X, 606, Vila Sao Geraldo, São Paulo"],
    ["bairro com nome igual à cidade, mas a pessoa disse 'bairro'", dado("Santo André", "São Paulo", "SP"), "bairro Santo André, São Paulo/SP"],
  ])("mantém: %s", (_n, d, texto) => {
    expect(lido(d, texto)?.bairro).toBe(d.imovel!.bairro);
  });
  it("o valor GRAVADO no rascunho é corrigido (não só o resumo)", async () => {
    const d = deps({
      extrairProposta: vi.fn().mockResolvedValue({
        proponente: { nome: "TESTE Comprador Smoke" },
        imovel: { endereco: "Rua Augusta, 100", bairro: "São Paulo", cidade: "São Paulo", uf: "SP" },
        valor: 500000,
      }),
    });
    const p = await F.iniciarFluxo(
      { tipo: "proposta", pedido: "proposta de compra, comprador TESTE Comprador Smoke, imóvel Rua Augusta, 100, São Paulo/SP, valor 500 mil", policy: [...TUDO], agora },
      d
    );
    const dados = (p.fluxo as Extract<Fluxo, { kind: "proposta" }>).dados;
    expect(dados.imovel?.bairro).toBeUndefined();
    expect(dados.imovel?.cidade).toBe("São Paulo");
    expect(dados.proponente?.nome).toBe("TESTE Comprador Smoke");
  });
});

describe("2. o nome sai como a pessoa escreveu (TESTE não é ruído)", () => {
  const nomeLido = (extraido: string, texto: string, papel: "proponente" | "vendedor" = "proponente") =>
    F.conferirDitado(F.sanearDados({ [papel]: { nome: extraido } }), texto)[papel]?.nome;

  it("caso do E2E: disse 'TESTE Comprador Smoke', o extrator devolveu 'Comprador Smoke'", () => {
    expect(nomeLido("Comprador Smoke", "comprador TESTE Comprador Smoke, telefone 11 98888-7777")).toBe("TESTE Comprador Smoke");
  });
  it("TESTE depois do nome, e com número", () => {
    expect(nomeLido("Maria Silva", "comprador Maria Silva TESTE, cpf 529.982.247-25")).toBe("Maria Silva TESTE");
    expect(nomeLido("Comprador Dois", "compradores TESTE2 Comprador Dois e outro")).toBe("TESTE2 Comprador Dois");
  });
  it("preserva a grafia escrita (caixa e acento)", () => {
    expect(nomeLido("Joao Gomes", "vendedor teste João Gomes, tel 11 97777-6666", "vendedor")).toBe("teste João Gomes");
  });
  it("não mexe quando o nome já veio inteiro ou não há 'TESTE' colado", () => {
    expect(nomeLido("TESTE Comprador Smoke", "TESTE Comprador Smoke")).toBe("TESTE Comprador Smoke");
    expect(nomeLido("Maria Silva", "comprador: Maria Silva, valor 500 mil")).toBe("Maria Silva");
    // "teste" separado do nome por pontuação ou palavra não faz parte dele
    expect(nomeLido("Maria Silva", "proposta de teste, comprador Maria Silva")).toBe("Maria Silva");
    expect(nomeLido("Maria Silva", "teste: Maria Silva")).toBe("Maria Silva");
  });
  it("'teste' de prosa não entra no nome (revisão L6)", () => {
    expect(nomeLido("João Silva", "é um teste João Silva, tel 11 98888-7777")).toBe("João Silva");
    expect(nomeLido("João Silva", "comprador é um teste João Silva")).toBe("João Silva");
    expect(nomeLido("João Silva", "isso é só um teste, comprador João Silva")).toBe("João Silva");
    expect(nomeLido("João Silva", "comprador João Silva teste de fogo")).toBe("João Silva");
    // a marca ditada como parte do nome continua valendo
    expect(nomeLido("Comprador Smoke", "comprador Comprador Smoke TESTE2")).toBe("Comprador Smoke TESTE2");
    expect(nomeLido("Comprador Smoke", "é um comprador TESTE Comprador Smoke")).toBe("TESTE Comprador Smoke");
  });
  it("não inventa: nome que o texto não traz fica como veio", () => {
    expect(nomeLido("Comprador Smoke", "comprador Fulano")).toBe("Comprador Smoke");
  });
});

describe("4. trocar o tipo de assinatura no cartão de envio", () => {
  const METODOS = [
    { valor: "whatsapp", rotulo: "WhatsApp" },
    { valor: "aceite", rotulo: "Aceite por WhatsApp" },
    { valor: "email", rotulo: "E-mail" },
  ];
  const cartao = (over: Partial<Extract<Fluxo, { kind: "proposta" }>> = {}): Fluxo => ({
    kind: "proposta", etapa: "envio", natureza: "venda", dados: { valor: 1 }, propostaId: "p1", codigo: "P-8",
    metodos: METODOS, metodo: METODOS[0], assinantes: [{ nome: "Letícia", papel: "proponente" }], atualizadoEm: agora, ...over,
  });

  it.each(["quero assinatura por aceite", "muda o tipo de assinatura para aceite", "troca o método para aceite", "prefiro aceite"])(
    "%s → o cartão passa a mostrar o método e NÃO envia",
    async (texto) => {
      const d = deps();
      const p = await F.conduzirFluxo(cartao(), ctx(texto), d);
      expect("liberar" in p && p.liberar).toBeFalsy();
      expect(p.reply).toContain("*Aceite por WhatsApp*");
      expect(p.reply).not.toContain("*WhatsApp*");
      expect(p.fluxo).toMatchObject({ etapa: "envio", metodo: { valor: "aceite" } });
      expect(d.acao).not.toHaveBeenCalled();
    }
  );
  it("o SIM seguinte envia com o método NOVO", async () => {
    const d = deps({ acao: vi.fn().mockResolvedValue({ status: 200, body: {} }) });
    const p = await F.conduzirFluxo(cartao(), ctx("quero assinatura por e-mail"), d);
    await F.conduzirFluxo(p.fluxo!, ctx("sim"), d);
    expect(d.acao).toHaveBeenCalledWith("proposal.send", { proposta_id: "p1", metodo: "email" }, expect.any(String));
  });
  it("método que não existe na lista: responde com os métodos suportados, nada muda e nada é enviado", async () => {
    const d = deps();
    const f = cartao({ metodos: [METODOS[0]!, METODOS[2]!] });
    const p = await F.conduzirFluxo(f, ctx("quero assinatura por aceite"), d);
    expect("liberar" in p && p.liberar).toBeFalsy();
    expect(p.reply).toContain("1. WhatsApp");
    expect(p.reply).toContain("2. E-mail");
    expect(p.reply).toContain("não está liberado");
    expect(p.fluxo).toMatchObject({ etapa: "metodo", metodo: { valor: "whatsapp" } });
    expect(d.acao).not.toHaveBeenCalled();
  });
  it("sem pedido de troca, o fluxo segue como antes (pergunta solta libera o turno)", async () => {
    const p = await F.conduzirFluxo(cartao(), ctx("quanto tempo demora?"), deps());
    expect("liberar" in p && p.liberar).toBe(true);
  });
  it.each([
    "muda o tipo do imóvel para casa",
    "coloca que o comprador deu aceite verbal",
    "deixa anotado que houve aceite verbal do comprador",
    "muda o tipo para casa",
    "troca a forma de pagamento para à vista",
  ])("'%s' não é troca de método: libera o turno, cartão intacto (revisão M2)", async (texto) => {
    const d = deps();
    const p = await F.conduzirFluxo(cartao(), ctx(texto), d);
    expect("liberar" in p && p.liberar).toBe(true);
    expect(p.fluxo).toMatchObject({ etapa: "envio", metodo: { valor: "whatsapp" } });
    expect(d.acao).not.toHaveBeenCalled();
  });
  it("'muda o método' sem dizer qual ainda mostra a lista", async () => {
    const p = await F.conduzirFluxo(cartao(), ctx("quero mudar o método"), deps());
    expect(p.fluxo).toMatchObject({ etapa: "metodo" });
  });
  it("'canal' é outra coisa (como o comprador recebe): não troca o método", async () => {
    const d = deps();
    const p = await F.conduzirFluxo(cartao(), ctx("troca o canal para email"), d);
    expect(p.fluxo).toMatchObject({ metodo: { valor: "whatsapp" } });
  });
});

function TOOL() {
  return F.TOOL_EXTRAIR_PROPOSTA as unknown as {
    parameters: { properties: { imovel: { properties: Record<string, unknown> } } };
  };
}
