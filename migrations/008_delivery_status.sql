-- 008 — Reconciliação de entrega (Fase 4A).
--
-- O ponto cego documentado em contractmaker/docs/max.md §8: depois do 202 do
-- /notify, ninguém sabia se a mensagem CHEGOU. `sent` significa só "a Z-API
-- aceitou" — desemparelhada, ela aceita com 200 e messageId válido e não
-- entrega nada (comentário da 001: provider_message_id NÃO é prova de
-- entrega). O canal que fecha o laço é o MessageStatusCallback da Z-API
-- (SENT/RECEIVED/READ), consumido pela rota /api/zapi-status/<secret>.
--
--   delivery_status: NULL        → nenhum callback ainda
--                    'sent'      → SENT confirmado pelo callback
--                    'delivered' → RECEIVED (chegou no aparelho)
--                    'read'      → READ/PLAYED
--                    'unconfirmed' → `sent` há mais que o prazo sem callback —
--                                    o estado que precisa acordar alguém
--   Upgrade monotônico: READ nunca regride para delivered; callback atrasado
--   nunca regride unconfirmed que já foi confirmado.
--
--   reported_at: quando o desfecho foi entregue ao Contractmaker
--   (POST /api/webhooks/max, costurado pela dedupe_key). NULL = ainda devendo;
--   o reconcile() retenta a cada passada do cron.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS read_at         TIMESTAMPTZ;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS reported_at     TIMESTAMPTZ;

-- O callback chega com o id do provedor; sem índice, cada status é um seq scan.
CREATE INDEX IF NOT EXISTS outbox_provider_message_id_idx
  ON outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- O mesmo laço para as RESPOSTAS do Max: reply_message_id era "escrita, nunca
-- lida" desde a 004. Agora o callback confirma que a resposta chegou.
ALTER TABLE inbound_queue ADD COLUMN IF NOT EXISTS reply_delivery_status TEXT;
ALTER TABLE inbound_queue ADD COLUMN IF NOT EXISTS reply_delivered_at    TIMESTAMPTZ;
ALTER TABLE inbound_queue ADD COLUMN IF NOT EXISTS reply_read_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS inbound_queue_reply_message_id_idx
  ON inbound_queue (reply_message_id)
  WHERE reply_message_id IS NOT NULL;
