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
  ])("%s é cumprimento", (t) => expect(ehCumprimento(t)).toBe(true));

  it.each([
    "já foi criada",
    "já fiz o acesso",
    "não sou corretor",
    "quero ver meus negócios",
    "oi, tudo bem?",
    "como cadastro uma venda?",
    "Max",
    "",
    "   ",
  ])("%s não é cumprimento", (t) => expect(ehCumprimento(t)).toBe(false));
});
