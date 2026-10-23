/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // `pg` e o checkpointer do LangGraph usam APIs de Node que o bundler não
    // deve tentar empacotar — sem isto o build quebra em `dns`/`net`. No Next
    // 14 a chave é esta; virou `serverExternalPackages` só no 15.
    serverComponentsExternalPackages: [
      "pg",
      "@langchain/langgraph-checkpoint-postgres",
    ],
  },
  // O bridge do Newton (`forwardToNewton`) chama `/agents/newton/run` na raiz,
  // o caminho do sidecar antigo. A rota mora em `/api/...`.
  async rewrites() {
    return [{ source: "/agents/newton/run", destination: "/api/agents/newton/run" }];
  },
};

module.exports = nextConfig;
