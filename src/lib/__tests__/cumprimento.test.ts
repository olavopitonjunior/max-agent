import { describe, expect, it } from "vitest";
import { ehCumprimento } from "@/lib/aceite";

describe("ehCumprimento", () => {
  it.each([
    "oi",
    "Oi!",
    "Olá, Max",
    "bom dia",
    "Boa tarde!!",
    "oi, bom dia",
    "ok e obrigado",
    "Obrigada 🙏",
    "valeu",
    "👍",
    "tudo bem",
    "oi, tudo bem?",
    "Bom dia, tudo bem?",
    "Oie",
    "Bom diaaa",
    "eae",
    "salve",
    "boa tarde pessoal",
    "bom dia a todos",
    "obrigadoo",
    "td bem",
    "oi :)",
    "oi rs",
    "kkk",
    "oi - bom dia",
    "Olá Max, tudo bem com você?",
    "👍🏽",
  ])("%s é cumprimento", (t) => expect(ehCumprimento(t)).toBe(true));

  it.each([
    "já foi criada",
    "já fiz o acesso",
    "não sou corretor",
    "quero ver meus negócios",
    "como cadastro uma venda?",
    "oi, quero ver meus negócios",
    "bom dia, a proposta foi enviada?",
    "...",
    "Max",
    "",
    "   ",
  ])("%s não é cumprimento", (t) => expect(ehCumprimento(t)).toBe(false));
});
