import { describe, it, expect } from "vitest";
import { humanizarCodigosInternos } from "../compose";
import { buildSystemPrompt, fenceToolResults } from "../prompt";

/**
 * Produção 10/11/2026 (Max Fincasa): o modelo copiou dado interno para a frase:
 *  - "o sistema retornou **sem_permissao** para o negócio X"
 *  - "está em Formulário (n=5). Quer que eu abra esse **n=5**"
 */
describe("código interno não chega à pessoa", () => {
  it("sem_permissao vira linguagem de pessoa", () => {
    const t = humanizarCodigosInternos("João, não consigo mostrar pendências: o sistema retornou **sem_permissao** para o negócio *TESTE assinatura 4*.");
    expect(t).not.toContain("sem_permissao");
    expect(t).toContain("**sem permissão**");
    expect(t).toContain("*TESTE assinatura 4*");
  });

  it('"(n=5)" some e "n=5" solto vira "item 5"', () => {
    const t = humanizarCodigosInternos(
      "o **TESTE assinatura 2** está em **etapa: Formulário** (n=5). Quer que eu abra esse **n=5**?"
    );
    expect(t).not.toMatch(/n\s*=\s*\d/);
    expect(t).toContain("Formulário**. Quer que eu abra esse **item 5**?");
  });

  it("não mexe em texto normal nem em 'n=' de outro contexto sem número", () => {
    const original = "A parcela 1 vence dia 5. Total de 3 itens, no item 2 há pendência.";
    expect(humanizarCodigosInternos(original)).toBe(original);
  });

  it("outros marcadores internos também são traduzidos", () => {
    const t = humanizarCodigosInternos("Falhou: referencia_invalida / negocio_nao_encontrado");
    expect(t).not.toMatch(/_/);
  });

  it("o resultado sem permissão chega ao modelo SEM o marcador interno e sem 'tente de novo'", () => {
    const cerca = fenceToolResults([{ tool: "minhas_pendencias", items: [{ sem_permissao: true }], truncated: false }]);
    expect(cerca).not.toContain("sem_permissao");
    expect(cerca).toContain('sem_acesso="true"');
    expect(cerca).toContain("NÃO ofereça tentar de novo");
  });

  it("o prompt proíbe escrever 'n=' e manda citar como lista numerada", () => {
    const p = buildSystemPrompt({ orgName: "FINCasa", userName: "Olavo", hits: [], pendencias: true }).replace(/\s+/g, " ");
    expect(p).toContain('nunca como "n=5"');
  });
});
