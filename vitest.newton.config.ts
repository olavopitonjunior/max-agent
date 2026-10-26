import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * A suíte inteira com o perfil `newton`. O config base força o perfil vazio
 * (Max); este roda os mesmos testes como o deploy do Newton para pegar o que
 * só funciona no Max. Testes que fixam o perfil com `vi.stubEnv` continuam
 * valendo o perfil que pedem.
 */
export default mergeConfig(base, defineConfig({ test: { env: { AGENT_DEPLOY_PROFILE: "newton" } } }));
