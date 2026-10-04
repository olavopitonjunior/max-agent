-- Custo do WhatsApp do Max (04/10/2026) — medir, não cobrar.
--
-- ── outbox.billable / pricing_category / pricing_type ─────────────────────
-- O que a Meta diz de CADA mensagem no webhook de status (`pricing`):
-- `billable` (cobrada ou não), a categoria em que foi cobrada (marketing,
-- utility…) e o tipo (`regular` = cobrada; `free_customer_service` = dentro
-- da janela). É a categoria NA HORA do envio — a do `wa_template` muda quando
-- a Meta reclassifica. NULL = o status ainda não veio, ou a linha é anterior.
--
-- ── meta_cost_daily ───────────────────────────────────────────────────────
-- O custo REAL cobrado pela Meta, por dia (UTC), categoria e tipo, lido do
-- `pricing_analytics` da WABA e filtrado pelo número do Max (a WABA é
-- compartilhada com o app da FINCasa). Na moeda da WABA (`currency`). O
-- rateio por imobiliária sai do outbox: mensagens cobráveis × custo unitário
-- do dia na categoria.
--
-- Aditiva; o código anterior ignora tudo. Roda ANTES do deploy.

SET LOCAL lock_timeout = '5s';

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS billable         boolean,
  ADD COLUMN IF NOT EXISTS pricing_category text,
  ADD COLUMN IF NOT EXISTS pricing_type     text;

CREATE TABLE IF NOT EXISTS meta_cost_daily (
  day          date          NOT NULL,
  category     text          NOT NULL,
  pricing_type text          NOT NULL,
  volume       int           NOT NULL DEFAULT 0,
  cost         numeric(14,6) NOT NULL DEFAULT 0,
  currency     text          NOT NULL DEFAULT '',
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (day, category, pricing_type)
);

-- O relatório do período filtra por envio; sem isto, varre o outbox inteiro.
CREATE INDEX IF NOT EXISTS outbox_sent_at_template_idx
  ON outbox (sent_at) WHERE template_name IS NOT NULL;
