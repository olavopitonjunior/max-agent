-- Janela de 24h da Cloud API da Meta, e o código de erro da Meta no outbox.
--
-- ── Por que existe ────────────────────────────────────────────────────────
--
-- Na Z-API não havia janela: texto livre a qualquer hora. Na Cloud API oficial
-- (2026-09, WABA da FINCasa), texto livre só sai até 24h depois da ÚLTIMA
-- mensagem da pessoa; fora disso, só template aprovado. E a recusa não vem na
-- hora: o envio costuma ser aceito com 200 e o erro 131047 chega depois, como
-- `status: failed` no webhook — tarde demais para a notificação, que já foi
-- dada como enviada.
--
-- Então o outbox pergunta ANTES de enviar. Esta tabela é a resposta: uma linha
-- por telefone com o instante da última mensagem recebida dele.
--
-- ── `conversation_window` ─────────────────────────────────────────────────
--
-- `phone` no formato de `conversationKey` (E.164 sem "+"), o mesmo de
-- `inbound_queue.from_phone` e `outbox.phone` — casar os dois é o ponto.
-- `last_inbound_at` é o instante da MENSAGEM no provedor, não o da chegada do
-- webhook: a janela da Meta conta a partir do que a pessoa mandou. Atualizada
-- com GREATEST, então uma reentrega atrasada nunca recua o relógio.
--
-- Poderia ser um MAX() sobre `inbound_queue`, mas aquela tabela não tem índice
-- por telefone e o outbox pergunta a cada linha, a cada minuto.
--
-- ── `outbox.error_code` ───────────────────────────────────────────────────
--
-- O código numérico da Meta (131047, 131026, …) quando o envio falhou. Em
-- `last_error` ele já aparece no texto, mas o painel precisa filtrar por ele
-- sem regex.
--
-- Aditiva: o código anterior ignora as duas coisas, então a migration roda em
-- produção ANTES do deploy.

CREATE TABLE IF NOT EXISTS conversation_window (
  phone           text        PRIMARY KEY,
  last_inbound_at timestamptz NOT NULL
);

-- Semeia com o que a fila já sabe. Só o que ainda poderia estar dentro da
-- janela interessa, mas semear tudo é barato e evita um corte arbitrário.
INSERT INTO conversation_window (phone, last_inbound_at)
SELECT from_phone,
       max(COALESCE(to_timestamp(timestamp_ms / 1000.0), created_at))
  FROM inbound_queue
 WHERE from_phone IS NOT NULL AND from_phone <> ''
 GROUP BY from_phone
ON CONFLICT (phone) DO UPDATE
   SET last_inbound_at = GREATEST(conversation_window.last_inbound_at, EXCLUDED.last_inbound_at);

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS error_code int;
