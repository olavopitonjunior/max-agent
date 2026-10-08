import { describe, it, expect } from "vitest";
import { referenciaPropostaExistente, pedeContinuidade } from "../continuidade";

/** A guarda de iniciarFluxo barra criação quando qualquer uma das duas detecta
 * proposta existente. Tabela de frases: criação legítima × referência. */
const barra = (t: string) => referenciaPropostaExistente(t) || pedeContinuidade(t);

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
  ])("criação passa: %s", (t) => expect(barra(t)).toBe(false));

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
  ])("referência barra: %s", (t) => expect(barra(t)).toBe(true));
});
