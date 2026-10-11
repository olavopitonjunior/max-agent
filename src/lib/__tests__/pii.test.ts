import { describe, it, expect } from "vitest";
import {
  tokenizar,
  destokenizar,
  destokenizarProfundo,
  destokenizarResposta,
  destokenizarArgs,
  redigir,
} from "@/lib/pii";

// CPF de teste conhecido, DV válido (111.444.777-35 ≡ 11144477735).
const CPF = "111.444.777-35";
const CPF_SEM_MASCARA = "11144477735";
// CNPJ de teste conhecido, DV válido (11.222.333/0001-81).
const CNPJ = "11.222.333/0001-81";
const EMAIL = "corretor@imobiliaria.com.br";
const TEL = "(11) 98765-0003";
const TEL_SEM_MASCARA = "11987650003";
const CEP = "01310-100";

describe("tokenizar/destokenizar", () => {
  /**
   * Achado em review: testar `not.toContain(CPF.replace(/\D/g, ""))` contra
   * um texto que só tem o CPF COM pontuação é tautológico — essa string sem
   * pontuação nunca esteve no texto, então o `not.toContain` passa mesmo sem
   * redação nenhuma. Aqui o texto leva as DUAS formas (com e sem máscara) e
   * a asserção checa a forma que de fato apareceria se a redação falhasse.
   */
  it("troca CPF, CNPJ, e-mail, telefone, CEP e valor por token — nas DUAS formas", () => {
    const texto =
      `Meu CPF é ${CPF} (ou ${CPF_SEM_MASCARA}), o CNPJ da empresa é ${CNPJ}, ` +
      `me chama em ${EMAIL} ou no ${TEL}. Moro no CEP ${CEP} e o aluguel é R$ 1.500,00.`;
    const { texto: out, mapa } = tokenizar(texto);

    expect(out).toContain("⟨CNPJ_1⟩");
    expect(out).toContain("⟨EMAIL_1⟩");
    expect(out).toContain("⟨TEL_1⟩");
    expect(out).toContain("⟨CEP_1⟩");
    expect(out).toContain("⟨VALOR_1⟩");
    expect(out).not.toContain(CPF);
    expect(out).not.toContain(CPF_SEM_MASCARA);
    expect(out).not.toContain(EMAIL);

    // Destokenizar restaura o valor — as DUAS ocorrências do mesmo CPF (que
    // deram o MESMO token, D6) voltam com a forma gravada no mapa (a
    // primeira vista), não byte a byte do texto original.
    const restaurado = destokenizar(out, mapa);
    expect(restaurado).toContain(CPF);
    expect(restaurado).not.toContain("⟨");
  });

  it("mesmo valor, mesmo token — dentro da mesma chamada", () => {
    const texto = `CPF ${CPF} de novo: ${CPF}`;
    const { texto: out, mapa } = tokenizar(texto);
    expect(out).toBe("CPF ⟨CPF_1⟩ de novo: ⟨CPF_1⟩");
    expect(Object.keys(mapa)).toHaveLength(1);
  });

  /**
   * D6 (review): o MESMO CPF/telefone em duas formas diferentes (com e sem
   * máscara, com e sem +55) precisa dar o MESMO token — sem isso, destokenizar
   * só restaura uma das duas ocorrências e a outra fica com o token cru.
   */
  it("mesmo CPF em duas formas (com/sem máscara) = UM token só", () => {
    const { texto: out, mapa } = tokenizar(`CPF ${CPF} igual a ${CPF_SEM_MASCARA}`);
    expect(out).toBe("CPF ⟨CPF_1⟩ igual a ⟨CPF_1⟩");
    expect(Object.keys(mapa)).toHaveLength(1);
  });

  it("mesmo telefone com/sem +55 e com/sem máscara = UM token só", () => {
    const { texto: out, mapa } = tokenizar(`fala no ${TEL} ou +55${TEL_SEM_MASCARA}`);
    expect(out).toBe("fala no ⟨TEL_1⟩ ou ⟨TEL_1⟩");
    expect(Object.keys(mapa)).toHaveLength(1);
  });

  it("reaproveita o mapa entre mensagens do mesmo turno — não duplica token", () => {
    const { mapa: mapa1 } = tokenizar(`Primeira: ${CPF}`);
    const { texto: out2, mapa: mapa2 } = tokenizar(`Segunda: ${CPF} e ${EMAIL}`, mapa1);

    // O CPF repetido ganha o MESMO token da primeira mensagem.
    expect(out2).toContain("⟨CPF_1⟩");
    expect(out2).not.toContain("⟨CPF_2⟩");
    // O e-mail, novo nesta mensagem, ganha o próximo número da categoria DELE.
    expect(out2).toContain("⟨EMAIL_1⟩");
    expect(mapa2["⟨CPF_1⟩"]).toBe(CPF);
  });

  it("CPF/CNPJ só tokeniza com DV válido — dígito trocado não é tocado", () => {
    const cpfInvalido = "111.444.777-36"; // último dígito alterado
    const { texto: out } = tokenizar(`CPF ${cpfInvalido}`);
    expect(out).toBe(`CPF ${cpfInvalido}`);
  });

  it("destokenizarProfundo troca token dentro de objeto aninhado", () => {
    const { texto: out, mapa } = tokenizar(`fale com ${TEL}`);
    const args = { proponente: { nome: "Ana", telefone: out.replace("fale com ", "") } };
    const real = destokenizarProfundo(args, mapa);
    expect(real.proponente.telefone).toBe(TEL);
  });

  it("mapa vazio: destokenizarProfundo devolve o mesmo objeto (sem custo)", () => {
    const args = { a: "⟨TEL_1⟩" };
    expect(destokenizarProfundo(args, {})).toEqual(args);
  });
});

describe("tokenizar — negativos (não é PII)", () => {
  it("código de proposta PROP-2026-0001 não é tocado", () => {
    const texto = "A proposta PROP-2026-0001 está pronta.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it("data não é tocada", () => {
    const texto = "Agendado para 10/10/2026 às 15h, criado em 2026-10-05.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it("CRECI não é tocado", () => {
    const texto = "Corretor CRECI 123456-F, outro é CRECI-SP 98765.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it("números soltos de 1 a 3 dígitos não são tocados", () => {
    const texto = "São 2 quartos, bloco 7, apto 302, torre 12.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it('"apto 302" não é tocado nem pela categoria VALOR', () => {
    const texto = "Ela mora no apto 302 do bloco B.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it("número solto sem R$/reais não é VALOR", () => {
    const texto = "São 1500 metros até o metrô.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  /** D1 (review): sem `(?<!\d)` no início, a regex de TEL casava a CAUDA. */
  it("número de contrato de 13 dígitos não vira TEL (nem em parte)", () => {
    const texto = "contrato nº 2026000012345 assinado.";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  it("linha de boleto (dígitos longos, sem separador) não vira TEL", () => {
    const texto = "linha 34191790010104351004791020150008291070026000";
    expect(tokenizar(texto).texto).toBe(texto);
  });

  /** CPF de 11 dígitos com DV inválido não é, por acaso, lido como telefone. */
  it("CPF de 11 dígitos com DV inválido não vira TEL", () => {
    const texto = "CPF 111.444.777-36 (DV trocado)";
    expect(tokenizar(texto).texto).toBe(texto);
  });
});

describe("tokenizar — valores monetários (formato exato, sem cortar dígito)", () => {
  it.each([
    ["R$1500", "aluguel de R$1500", "aluguel de ⟨VALOR_1⟩"],
    ["R$ 1.500,00", "aluguel de R$ 1.500,00", "aluguel de ⟨VALOR_1⟩"],
    ["1500 reais", "aluguel de 1500 reais", "aluguel de ⟨VALOR_1⟩"],
    ["R$ 2 mil", "entrada de R$ 2 mil", "entrada de ⟨VALOR_1⟩"],
  ])("tokeniza %s por igualdade exata (não corta dígito)", (_formato, frase, esperado) => {
    expect(tokenizar(frase).texto).toBe(esperado);
  });
});

describe("destokenizarResposta vs destokenizarArgs — token sem mapa (D2)", () => {
  const SEM_MAPA = "⟨TEL_1⟩"; // nunca esteve no mapa desta chamada

  it("resposta: token sem mapa (de outro turno) vira [dado], nunca o valor nem o token cru", () => {
    const out = destokenizarResposta(`seu telefone é ${SEM_MAPA}`, {});
    expect(out).toBe("seu telefone é [dado]");
  });

  it("resposta: token MUTILADO (minúsculo, <>, espaço) SEM MAPA vira [dado]", () => {
    expect(destokenizarResposta("tel <tel_1>", {})).toBe("tel [dado]");
    expect(destokenizarResposta("tel ⟨ TEL_1 ⟩", {})).toBe("tel [dado]");
    expect(destokenizarResposta("cpf ⟨CPF⟩", {})).toBe("cpf [dado]"); // fixo, de outro turno
  });

  it("resposta: token QUE está no mapa deste turno é restaurado normalmente", () => {
    const mapa = { "⟨TEL_1⟩": TEL };
    expect(destokenizarResposta(`seu telefone é ${SEM_MAPA}`, mapa)).toBe(`seu telefone é ${TEL}`);
  });

  /**
   * C2 (review) — a FORMA mutilada (`<TEL_1>`, minúsculo, com espaço) é
   * normalizada pra chave canônica (`⟨TEL_1⟩`) e consultada no mapa ANTES
   * de desistir pra `[dado]`. Só cai em `[dado]` quando a chave canônica
   * não existe no mapa — nunca quando existe e a FORMA é que veio torta.
   */
  it.each([
    ["<TEL_1>", "forma <> maiúscula"],
    ["<tel_1>", "forma <> minúscula"],
    ["⟨ TEL_1 ⟩", "espaço dentro de ⟨⟩"],
    ["⟨tel_1⟩", "⟨⟩ minúsculo"],
  ])("resposta: token mutilado %s (%s) COM MAPA vira o valor real, não [dado]", (mutilado) => {
    const mapa = { "⟨TEL_1⟩": TEL };
    expect(destokenizarResposta(`seu telefone é ${mutilado}`, mapa)).toBe(`seu telefone é ${TEL}`);
  });

  /**
   * C2 (review) — `<b>`, `<br>` e comparação matemática (`x < y > z`) não
   * são token de categoria nenhuma: ficam intocados, nunca viram `[dado]`.
   */
  it.each([
    ["<b>negrito</b>", "<b>negrito</b>"],
    ["um <br> quebra de linha", "um <br> quebra de linha"],
    ["x < y > z", "x < y > z"],
  ])("resposta: %s não é token — fica intocado", (texto, esperado) => {
    expect(destokenizarResposta(texto, {})).toBe(esperado);
  });

  it("args: token sem mapa fica COMO ESTÁ — o ImobPro recusa, nunca inventa valor", () => {
    const args = { telefone: SEM_MAPA };
    expect(destokenizarArgs(args, {})).toEqual({ telefone: SEM_MAPA });
  });
});

describe("redigir (sem mapa, token fixo)", () => {
  it("token fixo, sem número — chamadas repetidas dão o mesmo resultado sem estado", () => {
    const texto = `CPF ${CPF} e CPF 529.982.247-25`;
    expect(redigir(texto, ["CPF"])).toBe("CPF ⟨CPF⟩ e CPF ⟨CPF⟩");
  });

  it("campos restringe a redação — CPF/CNPJ/EMAIL (uso do turnlog), nas DUAS formas de CPF", () => {
    const texto = `CPF ${CPF} (${CPF_SEM_MASCARA}), fala em ${EMAIL} ou ${TEL}, CEP ${CEP}, aluguel R$ 500,00`;
    const out = redigir(texto, ["CPF", "CNPJ", "EMAIL"]);
    expect(out).not.toContain(CPF);
    expect(out).not.toContain(CPF_SEM_MASCARA);
    expect(out).not.toContain(EMAIL);
    // Telefone, CEP e valor ficam em claro — decisão de produto do turnlog.
    expect(out).toContain(TEL);
    expect(out).toContain(CEP);
    expect(out).toContain("R$ 500,00");
  });

  it("default redige todas as categorias", () => {
    const texto = `${CPF} ${EMAIL} ${TEL}`;
    const out = redigir(texto);
    expect(out).not.toContain(EMAIL);
    expect(out).toContain("⟨CPF⟩");
    expect(out).toContain("⟨EMAIL⟩");
    expect(out).toContain("⟨TEL⟩");
  });

  it("não toca nos negativos (mesmos do tokenizar)", () => {
    const texto = "PROP-2026-0001, CRECI 123456-F, 10/10/2026, apto 302";
    expect(redigir(texto)).toBe(texto);
  });
});
