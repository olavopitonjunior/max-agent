/**
 * O nano escolhe a tool de LEITURA certa entre vizinhas?
 *
 * O risco nomeado na spec: com várias tools de descrição parecida, a precisão
 * de escolha de um modelo nano cai rápido (separar `propor_criacao` em três
 * derrubou o recall de 100% para 50%).
 *
 * Dois modos:
 *  - padrão: o turn como em PRODUÇÃO — cada tool só entra se o prefiltro dela
 *    casar (leituras via `selecionarTools` com todas as capabilities de
 *    usuário; `propor_criacao` via `shouldOfferTools`);
 *  - `--sem-prefiltro`: as quatro sempre juntas, o pior caso de vizinhança.
 *
 * Critério (spec §6.2): por tool, recall ≥ 85% e precisão ≥ 90%.
 *
 * Uso:  OPENROUTER_API_KEY=... npx tsx scripts/eval-tool-leitura.ts [--model x]
 * Custo: ~40 chamadas de ~700 tokens de entrada. Centavos.
 */

import { complete, DEFAULT_MODEL } from "../src/lib/llm";
import { buildSystemPrompt } from "../src/graph/prompt";
import { FORM_TOOL, TOOLS_DE_LEITURA, selecionarTools, shouldOfferTools } from "../src/graph/tools";
import type { Capability } from "../src/graph/policy";

type Esperado = "listar_negocios" | "pendencias_do_negocio" | "listar_propostas" | "propor_criacao" | null;

const CASOS: { texto: string; esperado: Esperado }[] = [
  // ── listar_negocios: andamento, etapa, carteira ─────────────────────────
  { texto: "como estão meus negócios?", esperado: "listar_negocios" },
  { texto: "me dá um resumo da minha carteira", esperado: "listar_negocios" },
  { texto: "em que etapa está o negócio da Rua das Flores?", esperado: "listar_negocios" },
  { texto: "quais negócios eu tenho em andamento?", esperado: "listar_negocios" },
  { texto: "lista meus negócios de locação", esperado: "listar_negocios" },
  { texto: "qual o status dos meus negócios essa semana?", esperado: "listar_negocios" },
  { texto: "quantos negócios eu tenho abertos?", esperado: "listar_negocios" },
  { texto: "me mostra os processos que estou acompanhando", esperado: "listar_negocios" },

  // ── pendencias_do_negocio: o que falta ──────────────────────────────────
  { texto: "o que está faltando nos meus negócios?", esperado: "pendencias_do_negocio" },
  { texto: "tem alguma pendência pra eu resolver?", esperado: "pendencias_do_negocio" },
  { texto: "falta alguma certidão?", esperado: "pendencias_do_negocio" },
  { texto: "algum negócio meu está travado?", esperado: "pendencias_do_negocio" },
  { texto: "quais documentos ainda estão pendentes?", esperado: "pendencias_do_negocio" },
  { texto: "tem coisa parada esperando por mim?", esperado: "pendencias_do_negocio" },
  { texto: "o que falta pra fechar os contratos?", esperado: "pendencias_do_negocio" },
  { texto: "saiu a certidão ou ainda tá pendente?", esperado: "pendencias_do_negocio" },

  // ── listar_propostas: acompanhar ────────────────────────────────────────
  { texto: "como estão minhas propostas?", esperado: "listar_propostas" },
  { texto: "a proposta do Carlos foi aceita?", esperado: "listar_propostas" },
  { texto: "quais propostas estão esperando assinatura?", esperado: "listar_propostas" },
  { texto: "alguma proposta minha foi recusada?", esperado: "listar_propostas" },
  { texto: "tenho proposta expirada?", esperado: "listar_propostas" },
  { texto: "me lista as propostas enviadas", esperado: "listar_propostas" },
  { texto: "o proponente já assinou a proposta?", esperado: "listar_propostas" },
  { texto: "quantas propostas eu tenho em rascunho?", esperado: "listar_propostas" },

  // ── propor_criacao: CRIAR não é listar (a vizinha mais perigosa) ────────
  { texto: "cria uma proposta pro Carlos", esperado: "propor_criacao" },
  { texto: "monta um rascunho de proposta pra esse cliente", esperado: "propor_criacao" },
  { texto: "abre um formulário de venda pro João", esperado: "propor_criacao" },

  // ── Nenhuma: pergunta de processo, conversa ─────────────────────────────
  { texto: "como funciona a assinatura pela ClickSign?", esperado: null },
  { texto: "quanto tempo demora a certidão de matrícula?", esperado: null },
  { texto: "o que é uma proposta de compra?", esperado: null },
  { texto: "bom dia, tudo bem?", esperado: null },
  { texto: "quando cai a comissão depois do contrato assinado?", esperado: null },
  { texto: "valeu, obrigado!", esperado: null },
];

async function main() {
  const i = process.argv.indexOf("--model");
  const model = i >= 0 ? process.argv[i + 1] : DEFAULT_MODEL;
  // Usuário da plataforma: é quem recebe as leituras E a propor_criacao em produção.
  const system = buildSystemPrompt({ orgName: "RE/MAX Trio", userName: "Marcia Gerente", hits: [], podeEscrever: true });
  const semPrefiltro = process.argv.includes("--sem-prefiltro");
  const TODAS: Capability[] = ["deal.list", "deal.detail", "deal.pending", "proposal.list", "proposal.detail"];
  const toolsDoTurn = (texto: string) =>
    semPrefiltro
      ? [...TOOLS_DE_LEITURA.map((t) => t.def), FORM_TOOL]
      : [
          ...selecionarTools({ policy: TODAS, texto }).tools.map((t) => t.def),
          ...(shouldOfferTools(texto) ? [FORM_TOOL] : []),
        ];

  console.log(`modelo: ${model}\ncasos:  ${CASOS.length}\nmodo:   ${semPrefiltro ? "sem prefiltro (pior caso)" : "produção (com prefiltro)"}\n`);

  const nomes: Exclude<Esperado, null>[] = [
    "listar_negocios",
    "pendencias_do_negocio",
    "listar_propostas",
    "propor_criacao",
  ];
  const vp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const fn: Record<string, number> = {};
  for (const n of nomes) vp[n] = fp[n] = fn[n] = 0;
  const erros: string[] = [];
  let tokensIn = 0;

  for (const caso of CASOS) {
    const tools = toolsDoTurn(caso.texto);
    const r =
      tools.length > 0
        ? await complete({ system, messages: [{ role: "user", content: caso.texto }], model, tools })
        : { toolCalls: [] as { name: string }[], usage: { promptTokens: 0 } };
    tokensIn += r.usage?.promptTokens ?? 0;
    const chamada = r.toolCalls[0]?.name ?? null;

    if (chamada === caso.esperado) {
      if (chamada) vp[chamada]++;
      process.stdout.write(".");
      continue;
    }
    process.stdout.write("x");
    if (caso.esperado) fn[caso.esperado]++;
    if (chamada && chamada in fp) fp[chamada]++;
    erros.push(`  esperado ${caso.esperado ?? "nenhuma"}, veio ${chamada ?? "nenhuma"}: "${caso.texto}"`);
  }

  console.log("\n");
  let reprovou = false;
  /**
   * `propor_criacao` NÃO é julgada aqui pelo recall: com 3 casos, um erro do
   * nano vira 67%. A qualidade da criação é da `eval-tool-choice.ts` (25
   * casos). O que ESTA eval prova sobre ela é a vizinhança: nenhum pedido de
   * criação pode ter ido para uma leitura — é o defeito que a eval achou
   * (com `listar_propostas` ao lado, a criação caía de 93% para 33%).
   */
  const desviados = erros.filter((e) => e.includes("esperado propor_criacao") && !e.includes("veio nenhuma"));
  console.log(
    `${desviados.length === 0 ? "✓" : "✗"} propor_criacao         nenhuma criação desviada para leitura (${desviados.length} desvio(s))`
  );
  if (desviados.length > 0) reprovou = true;
  for (const n of nomes.filter((x) => x !== "propor_criacao")) {
    const rec = vp[n] + fn[n] > 0 ? vp[n] / (vp[n] + fn[n]) : 1;
    const pre = vp[n] + fp[n] > 0 ? vp[n] / (vp[n] + fp[n]) : 1;
    const ok = rec >= 0.85 && pre >= 0.9;
    if (!ok) reprovou = true;
    console.log(
      `${ok ? "✓" : "✗"} ${n.padEnd(22)} recall ${(rec * 100).toFixed(0).padStart(3)}%  precisão ${(pre * 100)
        .toFixed(0)
        .padStart(3)}%`
    );
  }
  if (erros.length) console.log(`\n${erros.join("\n")}`);
  console.log(`\ntokens de entrada: ${tokensIn}`);
  console.log(reprovou ? "\nVEREDITO: REPROVADO no critério da spec (recall ≥ 85%, precisão ≥ 90%)." : "\nVEREDITO: aprovado.");
  process.exit(reprovou ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
