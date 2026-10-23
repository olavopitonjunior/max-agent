import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O nome do agente vem do perfil (`nomeDoAgente()`): o Newton não pode dizer
 * "Max" a ninguém. Este teste varre `src/` atrás de "Max" em linha que não é
 * comentário. Quem fica é só o que não chega à pessoa no WhatsApp, cada um
 * com o motivo.
 */
const PERMITIDOS: { arquivo: string; trecho: string; motivo: string }[] = [
  { arquivo: "src/lib/templates/catalog.ts", trecho: "Eu sou o Max", motivo: "template aprovado na Meta; o Newton não usa template" },
  { arquivo: "src/lib/templates/catalog.ts", trecho: "como Max:", motivo: "template aprovado na Meta; o Newton não usa template" },
  { arquivo: "src/lib/llm.ts", trecho: '"X-Title": "Max Agent (ImobPro)"', motivo: "cabeçalho para o OpenRouter, não chega à pessoa" },
  { arquivo: "src/lib/custos/meta-analytics.ts", trecho: "número de exibição do Max", motivo: "erro interno do número Meta" },
  { arquivo: "src/lib/custos/meta-analytics.ts", trecho: "nenhum do Max", motivo: "log interno do número Meta" },
  { arquivo: "src/lib/runtime/catalog.ts", trecho: "'proposal.list'", motivo: "descrição interna do catálogo" },
  { arquivo: "src/lib/runtime/catalog.ts", trecho: "recoveryOnly", motivo: "descrição interna do catálogo" },
  { arquivo: "src/lib/deploy-profile.ts", trecho: 'agentName: "Max"', motivo: "é a fonte do nome" },
  { arquivo: "src/app/layout.tsx", trecho: '"Max Agent"', motivo: "título da raiz do deploy, não chega ao WhatsApp" },
  { arquivo: "src/app/page.tsx", trecho: "Max Agent", motivo: "raiz do deploy, não chega ao WhatsApp" },
  { arquivo: "src/app/page.tsx", trecho: "Agentes → Max", motivo: "raiz do deploy, não chega ao WhatsApp" },
];

const RAIZ = join(__dirname, "..", "..", "..");

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return nome === "__tests__" ? [] : arquivosTs(caminho);
    return /\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

function ehComentario(linha: string): boolean {
  const t = linha.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--");
}

describe("nome fixo do agente", () => {
  it("nenhum 'Max' fora da lista de permitidos", () => {
    const achados: string[] = [];
    for (const caminho of arquivosTs(join(RAIZ, "src"))) {
      const arquivo = relative(RAIZ, caminho);
      readFileSync(caminho, "utf8")
        .split("\n")
        .forEach((linha, i) => {
          if (ehComentario(linha) || !/\bMax\b/.test(linha)) return;
          const permitido = PERMITIDOS.some((p) => p.arquivo === arquivo && linha.includes(p.trecho));
          if (!permitido) achados.push(`${arquivo}:${i + 1}`);
        });
    }
    expect(achados).toEqual([]);
  });
});
