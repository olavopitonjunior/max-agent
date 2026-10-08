import { describe, it, expect } from "vitest";
import { referenciaPropostaExistente, pedeContinuidade } from "../continuidade";

/** A guarda de iniciarFluxo barra criação quando qualquer uma das duas detecta
 * proposta existente. Frases reais e do code review do #65 (verbos fora da
 * lista também), não só as que a implementação já cobre. */
type Tipo = "venda" | "locacao" | "proposta";
const barra = (t: string, tipo?: Tipo) => referenciaPropostaExistente(t, tipo) || pedeContinuidade(t);

describe("guarda de criação × proposta existente", () => {
  it.each([
    "Faz uma proposta do João",
    "Cria uma proposta da Letícia",
    "Quero fazer uma proposta de venda",
    "Monta a proposta do Carlos pro apto 52",
    "Crie uma proposta de compra do Pedro",
    "Max, crie proposta da Ana",
    "Nova proposta da Ana",
    "Gere uma proposta do João",
    "faz uma proposta pra virar negócio",
    "cria uma proposta nova que vai virar locação",
    "não quero transformar, quero uma proposta nova da Ana",
    "Quero uma proposta do João",
    "Preciso de uma proposta da Maria",
    "Manda uma proposta do João",
    "Faz pra mim uma proposta do João",
    "Emite uma proposta do João",
    "Cira uma proposta do João",
    "Quero uma proposta de compra",
    "Preciso de uma proposta de aluguel",
    "Não é pra converter. Faz uma proposta nova do João",
    "Faz a proposta do Pedro que ele vai virar cliente",
  ])("criação passa (qualquer classificação): %s", (t) => {
    expect(barra(t, "proposta")).toBe(false);
    expect(barra(t, "venda")).toBe(false);
  });

  it.each(["Proposta do João, venda, 500 mil", "Max, proposta da Ana", "Redige a proposta da Ana", "Gera pra mim a proposta da Ana"])(
    "pedido de proposta citando pessoa não é barrado: %s",
    (t) => expect(barra(t, "proposta")).toBe(false)
  );

  it.each(["faz uma proposta nova igual a essa proposta", "Crie uma proposta a partir da proposta da Letícia"])(
    "proposta nova inspirada em outra é criação de proposta: %s",
    (t) => expect(referenciaPropostaExistente(t, "proposta")).toBe(false)
  );

  it.each(["não transforma em negócio ainda", "não converte a proposta agora", "Max, não é pra transformar a proposta da Ana"])(
    "negação com verbo informal não converte: %s",
    (t) => expect(pedeContinuidade(t)).toBe(false)
  );

  it.each([
    "Aproveite a proposta da Letícia e gere um link",
    "Crie um negócio a partir da proposta da Letícia",
    "Cria negócio da proposta da Letícia",
    "gera o contrato da proposta da Maria",
    "abre ficha da proposta do João",
    "Pega a proposta do João e faz o negócio",
    "Gere um formulário a partir de PROP-2026-0001",
    "Gere um formulário com os dados dessa proposta",
    "Cria o formulário da proposta assinada da Letícia",
    "Faça a proposta da Letícia virar negócio",
    "Max, tranforme a proposta da Letícia em negócio e gere o link do formulário",
    "Abre a proposta da Letícia e transforma em negócio",
    "transforma a proposta em negócio",
    "Não é pra criar proposta nova, transforma a da Letícia em negócio",
    "gera o negócio da Letícia, a proposta já foi assinada",
    "a Letícia assinou a proposta, gera o negócio",
    "Gera a ficha da Letícia a partir da proposta",
  ])("referência barra mesmo com o modelo dizendo venda: %s", (t) => expect(barra(t, "venda")).toBe(true));

  it.each([
    "transforma a proposta da Letícia em negócio",
    "converte a proposta da Letícia em negócio",
    "tranforma a proposta do João em negócio",
    "trasforme a proposta da Letícia em negócio",
    "transfome a proposta da Letícia em negócio",
    "A proposta da Letícia vira negócio",
    "passa a proposta da Letícia pra negócio",
  ])("conversão informal é interceptada antes do modelo: %s", (t) => expect(pedeContinuidade(t)).toBe(true));

  it.each(["converse com o cliente sobre a proposta", "Não é pra converter a proposta", "Como transformar a proposta em negócio?"])(
    "não é pedido de conversão: %s",
    (t) => expect(pedeContinuidade(t)).toBe(false)
  );
});
