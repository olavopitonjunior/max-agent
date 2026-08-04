-- Fila de ENTRADA. O espelho do outbox, do outro lado da conversa.
--
-- Por que agora: o webhook rodava `runTurn` INLINE. O próprio comentário da
-- rota registrava o prazo — "aceitável porque o grafo ainda não chama modelo;
-- quando a Fase 2 entrar, isso tem que virar fila". A Fase 2 entrou em produção
-- em 2026-08-03. A premissa caiu e o código ficou.
--
-- O modo de falha é silencioso e por isso pior que duplicata: um turn mais lento
-- que o timeout do webhook faz a Z-API REENTREGAR; a reentrega esbarra no
-- dedupe, que já consumiu o `messageId`; e a pessoa fica sem resposta E sem
-- rastro. Quem olhar depois vê uma mensagem recebida e nenhum erro.
--
-- A raiz é `inbound_seen` ser ao mesmo tempo o dedupe e o único registro: ele
-- prova que a mensagem CHEGOU, nunca que ela foi RESPONDIDA. É a mesma lição do
-- `UserNotificationDelivery` do ImobPro — claim reivindicável, não terminal.
-- Aqui a linha da fila passa a ser o registro durável, e o estado dela diz em
-- qual das duas coisas a mensagem está.

CREATE TABLE IF NOT EXISTS inbound_queue (
  id                  TEXT PRIMARY KEY,
  -- O dedupe mora AQUI agora: uma tabela só decide se a mensagem já entrou.
  -- Dois lugares dizendo isso seriam duas verdades para "já processei?".
  message_id          TEXT NOT NULL UNIQUE,
  from_phone          TEXT NOT NULL,
  group_id            TEXT,
  kind                TEXT NOT NULL,
  text                TEXT,
  media_url           TEXT,
  mime_type           TEXT,
  sender_name         TEXT,
  reply_to_message_id TEXT,
  timestamp_ms        BIGINT,
  -- pending | processing | done | failed
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  -- Resposta que o grafo produziu, gravada ANTES de tentar enviar.
  --
  -- Separa os dois jeitos de falhar, que pedem tratamentos opostos: se o grafo
  -- rodou e o envio caiu, a retentativa só reenvia. Sem isto ela re-invocaria o
  -- grafo com a mesma mensagem — e como o checkpointer já gravou o turn na
  -- thread, a fala da pessoa apareceria DUAS vezes no histórico, além de pagar
  -- o modelo de novo.
  reply_text          TEXT,
  -- messageId da RESPOSTA enviada. É o que prova que o laço fechou.
  reply_message_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at     TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ
);

-- Varredura do cron: os dois estados reivindicáveis, mais antigos primeiro.
-- `processing` entra porque claim órfão (function morta no meio) precisa voltar
-- a ser elegível — sem isso, morrer entre o claim e a resposta seria
-- exatamente o silêncio que esta migration existe para eliminar.
CREATE INDEX IF NOT EXISTS inbound_queue_claimable_idx
  ON inbound_queue (status, created_at)
  WHERE status IN ('pending', 'processing');

-- Backfill do dedupe antigo: as mensagens já vistas entram como `done` para
-- que uma reentrega tardia da Z-API não vire turn novo. `inbound_seen` fica no
-- schema, sem uso, e sai numa migration futura — dropar tabela junto com a
-- mudança que a substitui não deixa caminho de volta se algo der errado.
INSERT INTO inbound_queue (id, message_id, from_phone, kind, status, settled_at, created_at)
SELECT
  gen_random_uuid()::text,
  s.message_id,
  '',           -- não guardávamos o telefone; a coluna é NOT NULL
  'unknown',
  'done',
  s.seen_at,
  s.seen_at
FROM inbound_seen s
ON CONFLICT (message_id) DO NOTHING;
