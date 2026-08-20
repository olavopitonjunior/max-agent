import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireHmac } from "@/lib/auth";
import { query } from "@/lib/db";
import { encrypt, __resetOrgCache } from "@/lib/orgs";
import {
  clearNegativeIdentityCache,
  clearIdentityCacheForOrg,
} from "@/lib/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  orgId: z.string().min(1),
  orgName: z.string().min(1).max(200),
  /** Cru. Cifrado aqui antes de tocar o banco. */
  apiToken: z.string().min(1).max(200),
  active: z.boolean().default(true),
});

/**
 * POST /orgs — o ImobPro entrega (ou rotaciona) o acesso do Max a um tenant.
 *
 * É o que torna a ativação de um tenant novo um clique em vez de um ritual: lá,
 * ligar `vendas.max` provisiona usuário de serviço, membership e token, e
 * empurra o resultado por aqui. Sem este endpoint, alguém teria que copiar o
 * token à mão para dentro do `org_config`.
 *
 * Auth: o MESMO HMAC do `/notify`. Um segredo compartilhado a menos, e o
 * formato está travado por vetor fixo nos dois repos
 * (`src/lib/__tests__/hmac-parity.test.ts`).
 *
 * Idempotente: `org_id` é PK e o upsert sobrescreve. Reenviar é seguro — e é
 * exatamente o que o lado de lá faz quando a primeira tentativa falha.
 */
export async function POST(req: NextRequest) {
  const auth = await requireHmac(req);
  if (!auth.ok) return auth.response;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(auth.rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const p = parsed.data;

  await query(
    `INSERT INTO org_config (org_id, org_name, api_token_enc, active)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id) DO UPDATE
       SET org_name = EXCLUDED.org_name,
           api_token_enc = EXCLUDED.api_token_enc,
           active = EXCLUDED.active`,
    [p.orgId, p.orgName, encrypt(p.apiToken), p.active]
  );

  // Limpa o cache DESTA instância. As outras levam até o TTL — tolerável aqui,
  // porque `orgById` confirma no banco antes de devolver "org desconhecida"
  // (ver o incidente 202/403 narrado em lib/orgs.ts).
  __resetOrgCache();

  // Org nova (ou reativada) muda quem a varredura de identidade acharia: um
  // número cacheado como "desconhecido" pode ser usuário DELA. Só os
  // NEGATIVOS: o upsert é retentado pelo Contractmaker e roda em rotação de
  // token — um wipe completo aqui apagava os greeted de todo mundo a cada
  // provisionamento. O cache é compartilhado (banco), vale para todas as
  // instâncias.
  await clearNegativeIdentityCache();

  return NextResponse.json({ ok: true, orgId: p.orgId, active: p.active });
}

const deleteSchema = z.object({ orgId: z.string().min(1) });

/**
 * DELETE /orgs — desativa o tenant no Max.
 *
 * Desativa em vez de apagar: a linha guarda o histórico de qual token estava em
 * uso, e a fila de saída referencia a org. `active = false` já a tira de
 * `listOrgs`.
 *
 * **Ressalva conhecida:** o cache é por instância serverless, então uma
 * instância que já leu a lista continua tratando a org como ativa por até o
 * TTL. Na prática o estrago é pequeno — do lado do ImobPro o token é revogado
 * junto e a feature desligada faz o roteador parar de mandar —, mas mensagens
 * já enfileiradas podem sair nesse intervalo.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireHmac(req);
  if (!auth.ok) return auth.response;

  let parsed;
  try {
    parsed = deleteSchema.safeParse(JSON.parse(auth.rawBody));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rows = await query<{ org_id: string }>(
    `UPDATE org_config SET active = false WHERE org_id = $1 RETURNING org_id`,
    [parsed.data.orgId]
  );
  __resetOrgCache();
  // Caducam só os vínculos positivos que apontavam para ESTA org.
  await clearIdentityCacheForOrg(parsed.data.orgId);

  // 200 mesmo quando não havia nada: desativar o que já não existe é o estado
  // desejado, e um 404 faria o lado de lá tratar sucesso como falha.
  return NextResponse.json({ ok: true, found: rows.length > 0 });
}
