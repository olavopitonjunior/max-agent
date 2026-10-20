/**
 * SQL da rota `POST /api/admin/playground`, num módulo próprio: `route.ts` do
 * Next só pode exportar handlers e config de rota — exportar estas constantes
 * de lá passa no tsc e no vitest e quebra o `next build`. O teste de
 * integração importa daqui para rodar as MESMAS strings contra o schema real.
 */
export const RASTRO_SELECT_SQL = `SELECT org_id, kind, inbound_text, transcript, reply_text,
            route, intent_json, tools_json, usage_json, timings_json,
            signals_json, degradado, latency_ms, error, created_at
       FROM conversation_turn
      WHERE message_id = $1
      ORDER BY created_at DESC
      LIMIT 1`;

export const DEDUPE_SELECT_SQL =
  "SELECT 1 AS ja_existe FROM conversation_turn WHERE message_id = $1 LIMIT 1";
