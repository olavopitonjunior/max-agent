-- Toque em botão de aviso (M6): trava de "isso já foi feito".
--
-- Cada linha é um efeito já reivindicado: o botão `acao` do aviso `row_id`. O
-- roteador (`lib/aviso-botao.ts`) faz `INSERT ... ON CONFLICT` antes de agir; o
-- segundo toque na mesma ação da mesma linha responde "já foi feito" sem repetir
-- o efeito (reenviar link, adiar atividade, agendar lembrete).
--
--  · `row_id`     — `outbox.id` do aviso tocado. Sem FK de propósito: a
--                   retenção da outbox pode apagar a linha, e esta trava não
--                   deve impedir isso nem herdar o lock dela.
--  · `acao`       — id da ação do aviso (`reenviar_link`, `adiar_1d`, ...).
--  · `message_id` — mensagem do toque que reivindicou (a mesma `messageId`
--                   volta a passar: reentrega do webhook).
--
-- Só CREATE TABLE IF NOT EXISTS: tabela nova, sem lock em tabela viva.
--
-- ORDEM DE DEPLOY: roda ANTES do código do M6. O código novo, sem esta tabela,
-- falha no primeiro toque de botão com efeito (os demais toques não dependem
-- dela); código antigo não conhece a tabela.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS aviso_toque (
  row_id     TEXT        NOT NULL,
  acao       TEXT        NOT NULL,
  message_id TEXT        NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (row_id, acao)
);
