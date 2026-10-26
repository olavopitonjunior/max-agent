import { describe, it, expect, afterEach } from "vitest";
import { PACKS, packsDoPerfil, capabilitiesDosPacks, type ToolPack } from "../index";
import { PERFIS, type DeployProfile } from "@/lib/deploy-profile";
import {
  ferramentasDoTurno,
  buscarNoRegistro,
  entradasDoDeploy,
  REGISTRO_DE_TOOLS,
  type EntradaDeLeitura,
} from "@/graph/tools";
import { CAPABILITIES, capabilitiesDoDeploy } from "@/graph/policy";
import type { Candidate } from "@/lib/identity";

const identity: Candidate = { kind: "user", orgId: "org1", orgName: "Test", userId: "u1", userName: "QA" };

const LEITURA_DO_PACK: EntradaDeLeitura = {
  tipo: "leitura",
  nome: "pack_teste_ler",
  capability: "deal.list",
  verb: "deal.list",
  risco: "nenhum",
  confirmacao: false,
  prioridade: 99,
  combina: (t: string) => /teste do pack/i.test(t),
  def: { name: "pack_teste_ler", description: "leitura de teste", parameters: { type: "object", properties: {} } },
} as unknown as EntradaDeLeitura;

const PACK_TESTE: ToolPack = { id: "teste", capabilities: [], entradas: [LEITURA_DO_PACK] };

afterEach(() => {
  delete process.env.AGENT_DEPLOY_PROFILE;
});

describe("tool packs", () => {
  it("nenhum perfil declara pack ainda e o registro de packs está vazio", () => {
    expect(Object.keys(PACKS)).toEqual([]);
    expect(PERFIS.max.toolPacks).toEqual([]);
    expect(PERFIS.newton.toolPacks).toEqual([]);
    expect(packsDoPerfil()).toEqual([]);
    process.env.AGENT_DEPLOY_PROFILE = "newton";
    expect(packsDoPerfil()).toEqual([]);
  });

  it("pack desconhecido no perfil lança, em vez de subir sem as tools", () => {
    const perfil: DeployProfile = { ...PERFIS.newton, toolPacks: ["nao-existe"] };
    expect(() => packsDoPerfil(perfil)).toThrow("tool_pack_desconhecido: nao-existe");
  });

  it("sem packs, o deploy é exatamente o núcleo (tools e capabilities)", () => {
    expect(entradasDoDeploy()).toEqual(REGISTRO_DE_TOOLS);
    expect(capabilitiesDoDeploy()).toEqual([...CAPABILITIES]);
    expect(capabilitiesDosPacks([])).toEqual([]);
  });

  it("packs vazios ⇒ ferramentasDoTurno igual ao padrão", () => {
    const params = { policy: [...CAPABILITIES], texto: "como estão meus negócios", identity };
    expect(ferramentasDoTurno({ ...params, packs: [] })).toEqual(ferramentasDoTurno(params));
  });

  it("leitura de pack entra no turno e é achada pelo despachante", () => {
    const r = ferramentasDoTurno({ policy: [...CAPABILITIES], texto: "faz o teste do pack", identity, packs: [PACK_TESTE] });
    expect(r.entradas.map((e) => e.nome)).toContain("pack_teste_ler");
    expect(buscarNoRegistro("pack_teste_ler", [PACK_TESTE])?.nome).toBe("pack_teste_ler");
    expect(buscarNoRegistro("pack_teste_ler")).toBeUndefined();
  });

  it("leitura de pack respeita a política", () => {
    const r = ferramentasDoTurno({ policy: [], texto: "faz o teste do pack", identity, packs: [PACK_TESTE] });
    expect(r.entradas.map((e) => e.nome)).not.toContain("pack_teste_ler");
  });

  it("pack com nome de tool do núcleo não sobe", () => {
    const nucleo = REGISTRO_DE_TOOLS[0];
    const colide: ToolPack = { id: "c", capabilities: [], entradas: [{ ...LEITURA_DO_PACK, nome: nucleo.nome }] };
    expect(() => entradasDoDeploy([colide])).toThrow(`tool_nome_duplicado: ${nucleo.nome}`);
  });

  it("capabilities de pack somam ao núcleo sem duplicar", () => {
    const comCap: ToolPack = { id: "x", capabilities: ["pack.x", "deal.list"], entradas: [] };
    expect(capabilitiesDoDeploy([comCap])).toEqual([...CAPABILITIES, "pack.x"]);
  });
});
