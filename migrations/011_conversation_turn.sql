-- Auditoria de conversa: uma linha por turn, com o que foi dito, o que custou
-- e quais ferramentas foram acionadas.
--
-- ── Por que existe ────────────────────────────────────────────────────────
--
-- Em 21/08, o primeiro dia de conversa real em produção, quatro defeitos
-- apareceram nos dois primeiros turnos — duas threads para a mesma pessoa,
-- memória gravando ausência-de-fato, e depois a perda de desfecho de entrega.
-- Todos foram achados garimpando tabela no banco, à mão, porque não havia
-- lugar nenhum onde a conversa estivesse registrada.
--
-- É a mesma lição do `outbox` antes da reconciliação: sem registro, "está
-- funcionando" e "está falhando em silêncio" têm exatamente a mesma aparência.
--
-- ── O que NÃO guarda ──────────────────────────────────────────────────────
--
-- Telefone fica INTEIRO aqui, como em `inbound_queue` e `outbox`: a coluna
-- está atrás de credencial de banco, e é ela que permite investigar "por que
-- fulano não recebeu". A máscara é da APRESENTAÇÃO (log e API), não do
-- armazenamento — mascarar na origem tornaria a tabela inútil justamente para
-- o uso que a justifica.
--
-- O conteúdo tem prazo: `CONVERSATION_TTL_DAYS` (default 90) apaga texto e
-- transcrição, preservando as métricas. O que a plataforma precisa para
-- entender custo não é o que a pessoa disse.

CREATE TABLE IF NOT EXISTS conversation_turn (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  phone         text NOT NULL,
  -- Costura com `inbound_queue.message_id` e com o log estruturado: uma busca
  -- por este id devolve o turn inteiro, do webhook ao envio.
  message_id    text,
  kind          text NOT NULL DEFAULT 'text',   -- text | audio | image | document
  -- O que a pessoa mandou (já transcrito, quando veio de mídia) e o original.
  inbound_text  text,
  transcript    text,
  reply_text    text,
  -- [{ name, args, outcome }] — o que o modelo pediu e o que aconteceu.
  tools_json    jsonb NOT NULL DEFAULT '[]',
  -- [{ model, promptTokens, completionTokens, cacheReadTokens, costUsd, latencyMs, success }]
  -- Lista, e não escalar: um turn faz 2+ chamadas (resposta, compactação,
  -- extração de memória) e somá-las num bucket só esconderia qual delas pesa.
  usage_json    jsonb NOT NULL DEFAULT '[]',
  latency_ms    int,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- O painel lê por tenant, do mais recente para trás.
CREATE INDEX IF NOT EXISTS conversation_turn_org_idx
  ON conversation_turn (org_id, created_at DESC);

-- Investigação por mensagem: "o que aconteceu com este turn?"
CREATE INDEX IF NOT EXISTS conversation_turn_message_idx
  ON conversation_turn (message_id)
  WHERE message_id IS NOT NULL;

-- A poda por idade varre por data e só toca linha que ainda tem conteúdo.
CREATE INDEX IF NOT EXISTS conversation_turn_poda_idx
  ON conversation_turn (created_at)
  WHERE inbound_text IS NOT NULL OR reply_text IS NOT NULL;
