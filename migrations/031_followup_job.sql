-- Aviso proativo depois do 202 do `captacao.send` (defeito 4, prod 19/11/2026).
--
-- O envio da captação para assinatura pode passar de 20 s no Contractmaker e voltar 202
-- ("Enviando…"). O fluxo respondia "pergunte como está" e ninguém avisava o corretor quando
-- terminava. `followup_job` guarda a conferência pendente: o cron do outbox consulta o
-- `captacao.list` com backoff curto e, ao ver o estado final, enfileira UMA mensagem no
-- outbox (com o `dedupe_key` do job como chave de idempotência).
--
--  · `kind`       — tipo da conferência. Hoje só `captacao_envio`; o CHECK é o contrato.
--  · `ref_id`     — id da captação no Contractmaker.
--  · `dedupe_key` — `captacao-envio:<captacaoId>:<messageId>` (UNIQUE): o mesmo envio não
--                   agenda duas conferências, e a mesma chave protege o outbox contra duas
--                   mensagens.
--  · `subject`    — quem consulta: `{kind:"user",userId}` ou `{kind:"broker",splitRecipientId}`.
--                   O `scope-action` exige o sujeito, e fora de um turno não há identidade para
--                   resolver; é o do corretor que enviou. Sem PII (só ids).
--  · `attempt`    — conferências que ainda viram "Enviando…" (define o backoff 30/60/120 s).
--  · `next_at`    — próxima conferência. O claim EMPURRA este campo (lease), porque
--                   `FOR UPDATE SKIP LOCKED` só segura o lock durante o statement (ver 002).
--  · `deadline_at`— criação + 5 min: passou disso e ainda "Enviando…", vira `gave_up` sem
--                   mensagem (o corretor ainda pode perguntar "como está").
--  · `status`     — pending | done | gave_up.
--
-- Tabela nova, nada existente muda: ordem de deploy livre, EXCETO que o código novo precisa
-- da tabela (o agendamento é best-effort e a falha não muda a resposta; o cron consulta a
-- tabela a cada passada e, sem ela, registra o erro sem derrubar o despacho).
CREATE TABLE IF NOT EXISTS followup_job (
  id          TEXT        PRIMARY KEY,
  org_id      TEXT        NOT NULL,
  phone       TEXT        NOT NULL,
  kind        TEXT        NOT NULL CHECK (kind IN ('captacao_envio')),
  ref_id      TEXT        NOT NULL,
  dedupe_key  TEXT        NOT NULL UNIQUE,
  subject     JSONB       NOT NULL,
  attempt     INT         NOT NULL DEFAULT 0,
  next_at     TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'gave_up')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Varredura do cron: só os pendentes, por vencimento.
CREATE INDEX IF NOT EXISTS followup_job_due_idx
  ON followup_job (next_at)
  WHERE status = 'pending';

-- `concluirConferenciaDeEnvio` acha o job pela captação.
CREATE INDEX IF NOT EXISTS followup_job_ref_idx
  ON followup_job (kind, ref_id)
  WHERE status = 'pending';
