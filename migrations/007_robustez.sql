-- 007 — Robustez: cache de identidade e idempotência de reenvio.
--
-- ── identity_cache ────────────────────────────────────────────────────────
-- Repõe o que a 003 tirou, agora com TTL. A 003 dropou a `phone_org_cache`
-- porque guardar UMA org escondia ambiguidade; esta tabela guarda o RESULTADO
-- da varredura (zero ou um candidato) por tempo curto, e o caso de dois ou
-- mais continua na `phone_org_choice`, que é decisão da pessoa e não cache.
--
-- Sem ela, TODA mensagem pagava a varredura completa: 2 fetches ao ImobPro
-- por org cadastrada — inclusive para números desconhecidos (spam vira
-- amplificador de custo) e para o usuário legítimo de org única, que é o caso
-- comum.
--
--   negative = true  → a varredura não achou ninguém. TTL longo (24h): quem
--                      não é cliente hoje raramente vira cliente na próxima
--                      hora, e o cadastro novo pode esperar o cache vencer.
--   negative = false → um único candidato; `payload` é o Candidate serializado.
--                      TTL curto (15min): desativação de vínculo precisa valer
--                      logo.
--   greeted          → o número desconhecido JÁ recebeu a apresentação do Max.
--                      A partir daí, silêncio até o cache expirar — responder
--                      cada spam consome cota da Z-API e confirma que o número
--                      é vivo.
CREATE TABLE IF NOT EXISTS identity_cache (
  phone       TEXT PRIMARY KEY,            -- E.164 COM "+", igual à phone_org_choice
  payload     JSONB,                       -- Candidate quando negative = false
  negative    BOOLEAN NOT NULL DEFAULT false,
  greeted     BOOLEAN NOT NULL DEFAULT false,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Idempotência de reenvio ──────────────────────────────────────────────
-- O buraco: a function morre DEPOIS do send e ANTES do UPDATE final. A linha
-- volta como órfã e o reprocesso reenviava a mesma mensagem. O marcador
-- registra "o envio COMEÇOU"; na retentativa, marcador presente + resposta
-- pronta = provavelmente enviado → liquida sem reenviar (at-most-once:
-- duplicata incomoda mais que o raro silêncio, e a reconciliação de entrega
-- da Fase 4 passa a confirmar o desfecho).
-- Falha DE ENVIO limpa o marcador — essa retentativa deve reenviar.
ALTER TABLE inbound_queue ADD COLUMN IF NOT EXISTS last_send_started_at TIMESTAMPTZ;
ALTER TABLE outbox        ADD COLUMN IF NOT EXISTS send_started_at      TIMESTAMPTZ;
