/**
 * Perfil de deploy: o mesmo motor sobe como Max (RE/MAX, API oficial da Meta)
 * ou como Newton (Newcore, bridge do Newton). Cada perfil é um deploy próprio,
 * com banco e envs próprios; nada aqui mistura os dois em runtime.
 *
 * `AGENT_DEPLOY_PROFILE` ausente ou vazio ⇒ `max`, exatamente o comportamento
 * de antes desta env existir. Valor desconhecido LANÇA: cair em `max` em
 * silêncio poria o Max atendendo um tenant que não é dele.
 *
 * Lido a cada chamada, sem cache — o custo é um `trim()` e os testes trocam a
 * env entre casos.
 */

export type AgentKey = "max" | "newton";
export type TransportName = "meta" | "newton-bridge" | "log";

export interface DeployProfile {
  agentKey: AgentKey;
  /** Nome com que o agente se apresenta e assina textos voltados à pessoa. */
  agentName: string;
  transport: TransportName;
  /** Ids de pacotes de tools exclusivos do perfil (`src/packs`). */
  toolPacks: readonly string[];
}

export const PERFIS: Readonly<Record<AgentKey, DeployProfile>> = Object.freeze({
  max: Object.freeze({ agentKey: "max", agentName: "Max", transport: "meta", toolPacks: Object.freeze([]) }),
  newton: Object.freeze({ agentKey: "newton", agentName: "Newton", transport: "newton-bridge", toolPacks: Object.freeze([]) }),
} as const satisfies Record<AgentKey, DeployProfile>);

export function deployProfile(): DeployProfile {
  const bruto = (process.env.AGENT_DEPLOY_PROFILE ?? "").trim().toLowerCase();
  if (bruto === "") return PERFIS.max;
  if (bruto === "max" || bruto === "newton") return PERFIS[bruto];
  throw new Error(`deploy_profile_invalido: ${bruto}`);
}

export function nomeDoAgente(): string {
  return deployProfile().agentName;
}
