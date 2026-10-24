import type { EntradaDeTool } from "@/graph/tools";
import { deployProfile, type DeployProfile } from "@/lib/deploy-profile";

/**
 * Pacote de tools exclusivo de um perfil de deploy (Newton: nc-data, memória;
 * Max: marketing). O núcleo (`REGISTRO_DE_TOOLS`) é de todos; o pack só existe
 * no deploy cujo perfil o lista em `toolPacks`.
 *
 * `capabilities` são as que o pack introduz além do núcleo. Elas entram no
 * catálogo do deploy (`capabilitiesDoDeploy`) e só nele: o teste de paridade
 * com o ImobPro continua comparando o núcleo.
 */
export interface ToolPack {
  id: string;
  capabilities: readonly string[];
  entradas: readonly EntradaDeTool[];
}

/** Registro dos packs. Vazio até a Fase 2 (nc-data, memória). */
export const PACKS: Readonly<Record<string, ToolPack>> = Object.freeze({});

/**
 * Os packs do perfil. Id desconhecido LANÇA: subir o Newton sem as tools que o
 * perfil promete é falha silenciosa que só aparece na conversa.
 */
export function packsDoPerfil(perfil: DeployProfile = deployProfile()): ToolPack[] {
  return perfil.toolPacks.map((id) => {
    const pack = Object.hasOwn(PACKS, id) ? PACKS[id] : undefined;
    if (!pack) throw new Error(`tool_pack_desconhecido: ${id}`);
    return pack;
  });
}

export function capabilitiesDosPacks(packs: readonly ToolPack[]): string[] {
  return packs.flatMap((p) => p.capabilities);
}
