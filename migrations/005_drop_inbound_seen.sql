-- `inbound_seen` sai: a fila de entrada assumiu o papel dela.
--
-- A migration 004 moveu o dedupe para o `UNIQUE(message_id)` de `inbound_queue`
-- e copiou as linhas antigas para lá. Desde então nenhum código lê ou escreve
-- nesta tabela — ela ficou de propósito, porque dropar junto com a mudança que
-- a substitui não deixaria caminho de volta se algo desse errado.
--
-- Passou. A fila está em produção desde 2026-08-04, com o dedupe funcionando
-- pelo caminho novo. Manter a tabela agora só oferece um segundo lugar onde
-- alguém pode achar que "já processei?" está escrito — e duas verdades sobre a
-- mesma pergunta é exatamente o problema que a 004 resolveu.
--
-- Em produção a tabela estava VAZIA quando a 004 rodou (ninguém tinha escrito
-- para o Max ainda), então o backfill não teve o que trazer e este DROP não
-- descarta histórico nenhum. Em qualquer outro ambiente, o que existia já foi
-- copiado.

DROP TABLE IF EXISTS inbound_seen;
