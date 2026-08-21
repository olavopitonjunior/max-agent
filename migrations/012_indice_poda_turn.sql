-- Corrige o índice parcial da poda da auditoria.
--
-- O índice da 011 tinha o predicado `inbound_text IS NOT NULL OR reply_text IS
-- NOT NULL`, mas o UPDATE do `pruneOldTurns` filtra os TRÊS campos de texto —
-- inclui `transcript`. O predicado da query não implica o do índice, então o
-- Postgres não pode usá-lo e a poda vai de seq scan. Não quebra nada; só torna
-- inútil o índice criado justamente para ela.
--
-- Migração nova em vez de editar a 011 porque a 011 JÁ FOI APLICADA e seu
-- checksum está no registro: editar arquivo aplicado é exatamente o que o
-- `migrate.ts` avisa e recusa. O caminho honesto é este.
DROP INDEX IF EXISTS conversation_turn_poda_idx;

CREATE INDEX IF NOT EXISTS conversation_turn_poda_idx
  ON conversation_turn (created_at)
  WHERE inbound_text IS NOT NULL
     OR reply_text IS NOT NULL
     OR transcript IS NOT NULL;
