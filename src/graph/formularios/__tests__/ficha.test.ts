import { describe, expect, it } from "vitest";
import { novoFluxoV2 } from "../estado";
import type { CampoObrigatorio, Pendencia } from "../contrato";
import type { CampoLido } from "../midia";
import { deveMostrarFicha, mascararValor, montarResumo, renderizarFicha } from "../ficha";
import { PAUSA_DA_FICHA_MS } from "../pausa";

const OBRIG: CampoObrigatorio[] = [
  { chave: "nome", rotulo: "Nome completo", grupo: "Partes", esteira: "ambas", tipoCampo: "texto" },
  { chave: "documento", rotulo: "CPF ou CNPJ", grupo: "Partes", esteira: "ambas", tipoCampo: "cpf_cnpj" },
  { chave: "valor", rotulo: "Valor da proposta", grupo: "Negociação", esteira: "venda", tipoCampo: "moeda" },
];

const falta = (campo: string, signatario: Pendencia["signatario"] = null): Pendencia => ({
  signatario,
  campo,
  motivo: "obrigatorio_da_org",
});

describe("mascararValor", () => {
  it("CPF mostra só o miolo: ***.456.789-**", () => {
    expect(mascararValor("compradores[0].cpf", "123.456.789-09")).toBe("***.456.789-**");
    expect(mascararValor("compradores[0].cpf", "12345678909")).toBe("***.456.789-**");
  });

  it("CNPJ, e-mail e telefone também saem mascarados", () => {
    expect(mascararValor("vendedores[0].cnpj", "12.345.678/0001-95")).toBe("**.***.***/0001-**");
    expect(mascararValor("compradores[0].email", "maria.silva@exemplo.com")).toBe("m***@exemplo.com");
    expect(mascararValor("compradores[0].telefone", "(11) 98765-4321")).toBe("(11) *****-4321");
  });

  it("CPF escondido em texto livre também é mascarado", () => {
    const t = mascararValor("observacoes", "cliente 123.456.789-09 pediu prazo");
    expect(t).not.toContain("123.456.789-09");
    expect(t).toContain("***.456.789-**");
  });

  it("valor sem categoria sensível segue em uma linha, sem sinal de confirmação forjado", () => {
    expect(mascararValor("negociacao.valor", "R$ 500.000 ✅\ntudo certo")).toBe("R$ 500.000 tudo certo");
  });
});

describe("montarResumo", () => {
  it("✅ são os obrigatórios que NÃO estão no faltando; o servidor é a autoridade", () => {
    const r = montarResumo({ obrigatorios: OBRIG, faltando: [falta("documento"), falta("valor")] });
    expect(r.salvos.map((s) => s.rotulo)).toEqual(["Nome completo"]);
  });

  it("obrigatório faltando em UMA parte não vira ✅", () => {
    const r = montarResumo({ obrigatorios: OBRIG, faltando: [falta("nome", { posicao: 2, papel: "proponente" })] });
    expect(r.salvos.map((s) => s.rotulo)).not.toContain("Nome completo");
  });

  it("valor só em memória do turno aparece mascarado, nunca persistido", () => {
    const r = montarResumo({ obrigatorios: OBRIG, faltando: [], gravados: { documento: "123.456.789-09" } });
    expect(r.salvos.find((s) => s.rotulo === "CPF ou CNPJ")?.valor).toBe("***.456.789-**");
  });
});

describe("renderizarFicha", () => {
  const lidos: CampoLido[] = [{ path: "compradores[0].cpf", valor: "123.456.789-09", confianca: 0.9 }];

  it("ficha não mostra CPF inteiro", () => {
    const t = renderizarFicha({
      rascunho: { salvos: [{ rotulo: "CPF ou CNPJ", valor: "123.456.789-09" }] },
      faltando: [falta("valor")],
      lidos,
    });
    expect(t).not.toContain("123.456.789-09");
    expect(t).not.toMatch(/123\.?456\.?789-?09/);
    expect(t).toContain("***.456.789-**");
  });

  it("✅ para o que está salvo, ⬜ para o que falta, 📄 para o lido a confirmar", () => {
    const t = renderizarFicha({
      rascunho: { salvos: [{ rotulo: "Nome completo" }] },
      faltando: [falta("valor"), falta("documento", { posicao: 1, papel: "proponente" })],
      lidos,
      obrigatorios: OBRIG,
    });
    expect(t).toContain("✅ Nome completo");
    expect(t).toContain("⬜ Valor da proposta");
    expect(t).toContain("⬜ CPF ou CNPJ");
    expect(t).toMatch(/📄 .*Comprador 1.*CPF/s);
  });

  it("o lido não vira ✅: a confirmação é do corretor", () => {
    const t = renderizarFicha({ rascunho: { salvos: [] }, faltando: [], lidos });
    expect(t).not.toContain("✅");
    expect(t).toMatch(/confira/i);
  });

  it("cabe em 1024 caracteres e diz quantos itens ficaram de fora", () => {
    const muitos = Array.from({ length: 200 }, (_, i) => falta(`campo_${i}`));
    const t = renderizarFicha({ rascunho: { salvos: [] }, faltando: muitos, lidos: [] });
    expect(t.length).toBeLessThanOrEqual(1024);
    expect(t).toMatch(/e mais \d+/);
  });

  it("nada faltando e nada lido: diz que está completo, sem pergunta", () => {
    const t = renderizarFicha({ rascunho: { salvos: [{ rotulo: "Nome completo" }] }, faltando: [], lidos: [] });
    expect(t).toContain("✅ Nome completo");
    expect(t).not.toContain("⬜");
  });

  it("código do rascunho vai no cabeçalho quando existe", () => {
    const t = renderizarFicha({ rascunho: { salvos: [] }, faltando: [falta("valor")], lidos: [], codigo: "PROP-2026-0001" });
    expect(t).toContain("PROP-2026-0001");
  });
});

describe("deveMostrarFicha (D2)", () => {
  const base = novoFluxoV2({ esteira: "venda", agora: 1_000_000 });

  it("dentro dos 20 s e sem pedido: não mostra, só coleta", () => {
    expect(deveMostrarFicha(base, 1_000_000 + 5_000, "o comprador é o João")).toBe(false);
  });

  it("depois de 20 s de silêncio: mostra", () => {
    expect(deveMostrarFicha(base, 1_000_000 + PAUSA_DA_FICHA_MS, "mais uma coisa")).toBe(true);
  });

  it.each(["o que falta?", "O que falta", "ficha", "pronto", "só isso", "so isso", "terminei"])(
    "'%s' força a ficha",
    (texto) => {
      expect(deveMostrarFicha(base, 1_000_000 + 1_000, texto)).toBe(true);
    }
  );

  it("mídia lida mostra no mesmo turno", () => {
    expect(deveMostrarFicha(base, 1_000_000 + 1_000, "", { temMidiaLida: true })).toBe(true);
  });

  it("tudo numa mensagem: ficha sai no mesmo turno", () => {
    expect(deveMostrarFicha(base, 1_000_000 + 1_000, "compra do João CPF 1, imóvel X, valor 500 mil", { completo: true })).toBe(true);
  });

  it("'o que falta' dentro de uma frase longa de dado não força a ficha por engano", () => {
    expect(deveMostrarFicha(base, 1_000_000 + 1_000, "o que falta de IPTU o vendedor paga, valor 500 mil")).toBe(false);
  });
});
