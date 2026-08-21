-- Uma pessoa, uma thread, uma memória.
--
-- Em 21/08, no primeiro dia de conversa real em produção, a mesma pessoa
-- apareceu em DUAS threads e DUAS memórias: o webhook da Z-API entrega o
-- telefone como `5511…` e qualquer chamador que normalizasse antes entregava
-- `+5511…`. O `threadIdFor` e as funções de memória recebiam a string CRUA, de
-- modo que o formato de entrada virava identidade. Nada falhou, nada logou.
--
-- O código passou a normalizar por `conversationKey` (E.164 sem "+", que é o
-- formato que `inbound_queue.from_phone` e `outbox.phone` já usam — assim a
-- semeadura da notificação cai na mesma thread da conversa por construção).
-- Esta migration alinha o que já estava gravado.
--
-- Sem hardcode de telefone: a regra é "tudo que tem '+' passa a não ter", e a
-- linha sem '+' vence quando as duas existem — ela é a que veio do WhatsApp, ou
-- seja, a conversa de verdade.

-- ── memory_facts ─────────────────────────────────────────────────────────
-- Primeiro descarta o que colidiria: a mesma (org, key) já existente na forma
-- canônica. Depois reescreve o que sobrou.
DELETE FROM memory_facts a
 WHERE a.phone LIKE '+%'
   AND EXISTS (
     SELECT 1 FROM memory_facts b
      WHERE b.org_id = a.org_id
        AND b.key = a.key
        AND b.phone = ltrim(a.phone, '+')
   );

UPDATE memory_facts
   SET phone = ltrim(phone, '+')
 WHERE phone LIKE '+%';

-- Ausência de fato não é fato. O extrator gravou `area_atuacao: "não
-- informado"` no primeiro turno; o `limpar()` agora recusa, mas o que já
-- entrou continua ocupando vaga e entrando no prompt como se fosse informação.
--
-- Esta lista é uma CÓPIA da cerca de `src/lib/memory.ts::limpar()`, e a cópia é
-- deliberada: é one-shot, remedia o passado, e não tem por que virar código
-- vivo. Se um dia a cerca do TS mudar, esta não precisa acompanhar — o que ela
-- limpou já foi limpo. (`nenhum` está fora das duas pelo mesmo motivo:
-- "filhos: nenhum" é fato genuíno.)
DELETE FROM memory_facts
 WHERE btrim(value) ~* '^(n[ãa]o (informad[oa]|dit[oa]|mencionad[oa]|especificad[oa]|sei|informou|declarad[oa])|sem informa[çc][ãa]o|desconhecid[oa]|indefinid[oa]|n/?a|nulo|null|none|-+|\?+)$';

-- ── checkpoints do LangGraph ─────────────────────────────────────────────
-- As tabelas nascem no primeiro `invoke` (PostgresSaver.setup()), então podem
-- não existir ainda — o mesmo guard que a rota /api/admin/forget usa.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      -- Thread duplicada: a forma com '+' é a órfã (nasceu de chamador que
      -- normalizava). A sem '+' é a que a Z-API alimenta. Some a órfã.
      EXECUTE format(
        'DELETE FROM %I a WHERE a.thread_id LIKE ''%%:+%%''
           AND EXISTS (SELECT 1 FROM %I b
                        WHERE b.thread_id = replace(a.thread_id, '':+'', '':''))',
        t, t
      );
      EXECUTE format(
        'UPDATE %I SET thread_id = replace(thread_id, '':+'', '':'')
          WHERE thread_id LIKE ''%%:+%%''',
        t
      );
    END IF;
  END LOOP;
END $$;
