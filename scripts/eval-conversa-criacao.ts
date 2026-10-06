/**
 * A conversa real de 2026-10-06 em que o Max "criou" uma proposta sem criar.
 *
 * "Pode gerar uma proposta pra mim?" → "venda ou locação?" → "Venda". No
 * terceiro turn a ferramenta tinha sumido (o prefiltro só olhava "Venda"), e o
 * nano improvisou cinco turns de coleta até dizer "proposta criada".
 *
 * Mede, no turn da resposta à desambiguação, se o modelo PROPÕE a criação com
 * os argumentos certos (`tipo: proposta`, natureza venda, nome quando dito).
 * `--antes` reproduz a oferta antiga (sem a mensagem anterior), para comparar.
 *
 * Uso:  OPENROUTER_API_KEY=... npx tsx scripts/eval-conversa-criacao.ts [--antes] [--n 10]
 * Custo: ~3×n chamadas de ~2k tokens. Centavos.
 */

import { complete, DEFAULT_MODEL } from "../src/lib/llm";
import { buildSystemPrompt, comoMensagemDoUsuario } from "../src/graph/prompt";
import { ferramentasDoTurno, pedidoEmAberto } from "../src/graph/tools";
import { argsDaCriacao } from "../src/graph/despachante";
import type { ChatMessage } from "../src/graph/graph";
import type { Capability } from "../src/graph/policy";

const POLITICA: Capability[] = ["deal.list", "deal.pending", "proposal.list", "form.create", "proposal.create"];
const OLAVO = { orgId: "org1", orgName: "FINCasa", kind: "user" as const, userId: "u1", userName: "Olavo" };

const PERGUNTA: ChatMessage[] = [
  { role: "user", content: "Pode gerar uma proposta pra mim?" },
  { role: "assistant", content: "Posso sim, Olavo. É proposta de **venda** ou de **locação**?" },
];

const CASOS: { resposta: string; natureza: "venda" | "locacao"; nome?: string }[] = [
  { resposta: "Venda", natureza: "venda" },
  { resposta: "Locação", natureza: "locacao" },
  { resposta: "Venda. Compradora Letícia Gonçalves Nogueira", natureza: "venda", nome: "Letícia" },
];

async function main() {
  const antes = process.argv.includes("--antes");
  const iN = process.argv.indexOf("--n");
  const n = iN > 0 && Number(process.argv[iN + 1]) > 0 ? Number(process.argv[iN + 1]) : 10;
  const model = DEFAULT_MODEL;
  const system = buildSystemPrompt({
    orgName: OLAVO.orgName,
    userName: OLAVO.userName,
    hits: [],
    criacao: "disponivel",
  });

  console.log(`modelo: ${model}  modo: ${antes ? "ANTES (só a mensagem atual)" : "DEPOIS (com a anterior)"}  n=${n}\n`);
  let ok = 0;
  let total = 0;
  for (const caso of CASOS) {
    const oferta = ferramentasDoTurno({
      policy: POLITICA,
      texto: caso.resposta,
      identity: OLAVO,
      textoAnterior: antes ? null : pedidoEmAberto(PERGUNTA),
    });
    const tools = oferta.entradas.map((e) => e.def);
    let acertos = 0;
    const amostras: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await complete({
        system,
        messages: [...PERGUNTA, { role: "user" as const, content: caso.resposta }].map((m) =>
          m.role === "user" ? { ...m, content: comoMensagemDoUsuario(m.content) } : m
        ),
        model,
        tools: tools.length > 0 ? tools : undefined,
      });
      const c = r.toolCalls.find((t) => t.name === "propor_criacao");
      const a = (c?.args ?? {}) as Record<string, unknown>;
      // O que vira pendência de fato: com a trava do nome do falante aplicada.
      const final = c ? argsDaCriacao(a, OLAVO.userName) : null;
      const natureza = final?.natureza ?? "venda";
      const certo =
        !!final &&
        final.tipo === "proposta" &&
        natureza === caso.natureza &&
        (caso.nome ? String(final.nomeCliente ?? "").includes(caso.nome) : !final.nomeCliente);
      if (certo) acertos++;
      else amostras.push(c ? `chamou ${JSON.stringify(a)}` : `texto: ${(r.text ?? "").slice(0, 120).replace(/\n/g, " ")}`);
    }
    ok += acertos;
    total += n;
    console.log(`${JSON.stringify(caso.resposta)}: ${acertos}/${n}  (tools oferecidas: ${tools.map((t) => t.name).join(", ") || "nenhuma"})`);
    for (const s of amostras.slice(0, 3)) console.log(`   ✗ ${s}`);
  }
  console.log(`\nTOTAL: ${ok}/${total} (${Math.round((100 * ok) / total)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
