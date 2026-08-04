-- Um turn por telefone de cada vez — garantido pelo BANCO, não por uma leitura.
--
-- ── O que estava errado ──────────────────────────────────────────────────────
-- A serialização por telefone entrou primeiro como um `NOT EXISTS` dentro do
-- WHERE do claim: "só reivindique esta linha se nenhuma outra do mesmo telefone
-- estiver em `processing`". Parece suficiente e não é.
--
-- Sob READ COMMITTED — que é o default, e este código nunca abre transação
-- explícita, então cada `query()` é um statement autocommitado — o `NOT EXISTS`
-- é uma leitura SEM lock, avaliada contra o snapshot do próprio statement. Ela
-- não enxerga escrita não-commitada de outra transação e não espera por ela.
--
-- Duas invocações concorrentes (caminho rápido + cron, ou duas mensagens
-- seguidas) reivindicando linhas DIFERENTES do MESMO telefone:
--
--   T1: SELECT ... NOT EXISTS → nenhuma processando  → UPDATE A = processing
--   T2: SELECT ... NOT EXISTS → nenhuma processando  → UPDATE B = processing
--       (T2 não vê A, porque T1 ainda não commitou)
--   ambas commitam → dois turns no MESMO thread_id
--
-- É check-then-act de manual. O compare-and-swap do `status` no UPDATE protege
-- a linha ALVO (o Postgres reavalia o WHERE na versão nova da linha travada),
-- mas isso não vale para a subquery, que olha linhas IRMÃS e não trava nada.
--
-- Consequência com escrita no grafo: se as duas mensagens forem a MESMA
-- confirmação enviada duas vezes, os dois turns leem o mesmo `pendingAction` do
-- checkpoint, os dois casam "sim", e os dois criam formulário — cada um com a
-- SUA `messageId` como chave de idempotência, então a idempotência do ImobPro
-- (que é por `(userId, key)`) não dedupa. Dois negócios de uma confirmação.
--
-- ── A correção ───────────────────────────────────────────────────────────────
-- O índice abaixo torna "no máximo uma linha em `processing` por telefone" uma
-- invariante do schema. Não é mais uma leitura que pode estar velha: a segunda
-- transação BLOQUEIA no índice até a primeira commitar e então falha com
-- violação de unicidade, que o código trata como "já tem alguém neste telefone".
--
-- O `NOT EXISTS` continua no WHERE, rebaixado a otimização: ele evita a maioria
-- das colisões antes de chegarem ao índice. A GARANTIA passou a ser o índice.

-- Pré-requisito do índice: não pode haver duplicata agora. Em produção a fila
-- está vazia, mas isto precisa ser idempotente e seguro em qualquer ambiente —
-- devolve à fila todas menos a mais antiga de cada telefone. `pending` e não
-- `failed` porque essas linhas não têm defeito: elas só não podiam estar
-- rodando ao mesmo tempo.
UPDATE inbound_queue
   SET status = 'pending'
 WHERE status = 'processing'
   AND id NOT IN (
     SELECT DISTINCT ON (from_phone) id
       FROM inbound_queue
      WHERE status = 'processing'
      ORDER BY from_phone, created_at
   );

CREATE UNIQUE INDEX IF NOT EXISTS inbound_queue_um_processing_por_telefone
  ON inbound_queue (from_phone)
  WHERE status = 'processing';
