-- 009 — Endurecimento da reconciliação (achados do code review do PR #6).
--
-- ── report_attempts ──────────────────────────────────────────────────────
-- O retry do report não tinha teto: 50 linhas permanentemente rejeitadas
-- pelo Contractmaker monopolizariam o lote para sempre (head-of-line) com
-- ~72k POSTs condenados por dia. O outbox já resolveu essa forma com
-- MAX_ATTEMPTS; o report ganha o mesmo contador.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS report_attempts INT NOT NULL DEFAULT 0;

-- ── Backfill do acervo pré-feature ───────────────────────────────────────
-- Sem isto, a primeira passada do reconcile marcaria TODO o histórico de
-- `sent` como unconfirmed (alarme falso garantido) e, com o secret
-- configurado, despejaria desfechos obsoletos no Contractmaker a 50/min.
-- Linhas anteriores à feature são carimbadas como "já reportadas": o laço
-- delas nunca teve callback e não há o que reconciliar retroativamente.
--
-- ⚠️ AS DUAS CERCAS ABAIXO NÃO SÃO ZELO — SÃO CORREÇÃO DE INCIDENTE (21/08).
--
-- `scripts/migrate.ts` REAPLICA todos os arquivos a cada execução. A versão
-- original deste UPDATE não tinha cerca nenhuma, então toda rodada de
-- `npm run db:migrate` carimbava como "já reportada" QUALQUER linha `sent`
-- pendente de report — inclusive as que tinham desfecho REAL, recém-chegado
-- por callback. Como o `reconcile()` só olha `WHERE reported_at IS NULL`,
-- esses desfechos eram perdidos para sempre, em silêncio.
--
-- Aconteceu de verdade: às 18:31 de 21/08, uma reaplicação de rotina apagou o
-- report pendente das DUAS únicas linhas que tinham desfecho (100% delas),
-- horas antes de a integração ser ligada.
--
--  · `delivery_status IS NULL` — linha que nunca recebeu callback. Uma linha
--    COM desfecho tem algo a reportar, por definição.
--  · `created_at < '2026-08-21'` — linha anterior à feature. Sem isto, uma
--    mensagem enviada há dois minutos (ainda sem callback, `delivery_status`
--    nulo e legitimamente à espera) seria carimbada e perderia o desfecho que
--    ainda estava a caminho.
--
-- As duas juntas tornam este UPDATE idempotente em DADO, não só em DDL — que
-- é o que um script "reaplica tudo sempre" exige de qualquer migração de
-- dados. Ver também a passada de dedup da 010, escrita com o mesmo cuidado.
UPDATE outbox
   SET reported_at = now()
 WHERE reported_at IS NULL
   AND status IN ('sent', 'failed')
   AND delivery_status IS NULL
   AND created_at < '2026-08-21 00:00:00+00';
