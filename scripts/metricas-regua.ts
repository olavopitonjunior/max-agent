/**
 * Métricas da régua final do Max (goals G1–G5 e guardrails definidos com o
 * Olavo em 02/10/2026 — `~/.claude/plans/max-regua-final.md`).
 *
 * Só LEITURA: abre a sessão em `default_transaction_read_only`, então nem por
 * engano escreve no banco que estiver apontado.
 *
 *   npx tsx scripts/metricas-regua.ts                     # últimos 30 dias
 *   npx tsx scripts/metricas-regua.ts --desde 2026-10-01 --ate 2026-11-01
 *   npx tsx scripts/metricas-regua.ts --org <orgId> --json
 *
 * ⚠️ O `.env.local` deste repo aponta para PRODUÇÃO (`OUTBOX_ENV` troca).
 *
 * Fontes:
 *  - banco do Max (`DATABASE_URL`): envio, entrega, aceite, repasse, conversa;
 *  - banco do contractmaker (`CM_DATABASE_URL`, opcional): onboarding
 *    concluído e resposta da pesquisa. Ausente = essas linhas saem "n/d";
 *  - Graph API (`META_ACCESS_TOKEN` + `META_PHONE_NUMBER_ID`, opcional): o
 *    quality rating do número. Ausente = "n/d".
 *
 * Cada métrica traz a META ao lado; "ok"/"abaixo" é só a comparação — com
 * amostra pequena (n < 20) a linha avisa, porque 1 de 2 não é 50% de nada.
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.OUTBOX_ENV ?? ".env.local" });

import {
  AMOSTRA_MINIMA,
  m,
  metricasDoContractmaker,
  metricasDoMax,
  somenteLeitura,
  qualidadeDoNumero,
  type Metrica,
  type Periodo,
} from "../src/lib/metricas-regua";

interface Args extends Periodo {
  json: boolean;
}

function lerArgs(argv: string[]): Args {
  const valor = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ate = valor("--ate") ? new Date(`${valor("--ate")}T00:00:00-03:00`) : new Date();
  const desde = valor("--desde")
    ? new Date(`${valor("--desde")}T00:00:00-03:00`)
    : new Date(ate.getTime() - 30 * 86_400_000);
  if (Number.isNaN(desde.getTime()) || Number.isNaN(ate.getTime()) || desde >= ate) {
    throw new Error("período inválido: use --desde AAAA-MM-DD --ate AAAA-MM-DD");
  }
  return { desde, ate, org: valor("--org") ?? null, json: argv.includes("--json") };
}

function formatar(x: Metrica): string {
  if (x.valor == null) return "n/d";
  switch (x.formato) {
    case "pct":
      return `${(Number(x.valor) * 100).toFixed(1)}%`;
    case "horas":
      return `${Number(x.valor).toFixed(1)}h`;
    default:
      return String(x.valor);
  }
}

function situacao(x: Metrica): string {
  const s = x.ok == null ? "—" : x.ok ? "ok" : "ABAIXO";
  return x.amostra != null && x.amostra < AMOSTRA_MINIMA ? `${s} (n=${x.amostra}, amostra pequena)` : s;
}

async function main() {
  const a = lerArgs(process.argv.slice(2));
  const urlMax = process.env.DATABASE_URL;
  if (!urlMax) throw new Error("DATABASE_URL ausente");
  const cmUrl = process.env.CM_DATABASE_URL;

  const { metricas, lembretes } = await somenteLeitura(urlMax, (c) => metricasDoMax(c, a));
  metricas.push(await qualidadeDoNumero());
  if (cmUrl) {
    metricas.push(...(await somenteLeitura(cmUrl, (c) => metricasDoContractmaker(c, a, lembretes))));
  } else {
    for (const [goal, nome, meta] of [
      ["G3", "tenants que concluíram a configuração em até 2 dias", "≥ 50%"],
      ["G3", "lembrados que concluíram em até 7 dias", "≥ 25%"],
      ["G4", "pesquisas respondidas (WhatsApp)", "≥ 30%"],
    ] as const) {
      metricas.push(m(goal, nome, null, "pct", meta, null, null, "contractmaker"));
    }
  }

  {
    const ordem = ["G1", "G2", "G3", "G4", "G5", "guardrail"];
    metricas.sort((x, y) => ordem.indexOf(x.goal) - ordem.indexOf(y.goal));

    if (a.json) {
      console.log(
        JSON.stringify(
          { desde: a.desde.toISOString(), ate: a.ate.toISOString(), org: a.org, metricas },
          null,
          2
        )
      );
      return;
    }
    const host = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return "?";
      }
    };
    console.log(
      `[metricas-regua] max: ${host(urlMax)} · contractmaker: ${cmUrl ? host(cmUrl) : "não informado"}\n` +
        `período: ${a.desde.toISOString().slice(0, 10)} → ${a.ate.toISOString().slice(0, 10)}` +
        (a.org ? ` · org ${a.org}` : "") +
        "\n"
    );
    console.log("goal".padEnd(10) + "métrica".padEnd(52) + "valor".padEnd(26) + "meta".padEnd(34) + "situação");
    console.log("-".repeat(144));
    for (const x of metricas) {
      console.log(
        x.goal.padEnd(10) + x.nome.padEnd(52) + formatar(x).padEnd(26) + x.meta.padEnd(34) + situacao(x)
      );
    }
  }
}

main().catch((err) => {
  console.error("[metricas-regua] falhou:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
