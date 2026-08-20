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
UPDATE outbox
   SET reported_at = now()
 WHERE reported_at IS NULL
   AND status IN ('sent', 'failed');
