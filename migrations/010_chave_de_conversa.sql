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
--
-- SIMPLIFICAÇÃO ASSUMIDA, e é assunção e não regra provada: em colisão a linha
-- SEM "+" vence, sem comparar `updated_at`. O raciocínio é o do incidente — a
-- forma sem "+" vem do WhatsApp (a conversa de verdade) e a com "+" vem de
-- chamador que normalizava antes (o `scripts/turn.ts`). Se um dia a linha com
-- "+" for a mais recente, o valor dela é descartado em silêncio. Aceitável
-- porque isto é limpeza one-shot de um raio de alcance conhecido (dia 1), não
-- uma política permanente.
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
-- limpou já foi limpo.
--
-- `nenhum` e `indefinido` estão fora das duas listas pelo mesmo motivo: são
-- FATO no vocabulário deste negócio ("filhos: nenhum", "prazo indefinido" de
-- contrato de locação), não ausência de informação.
DELETE FROM memory_facts
 WHERE btrim(value) ~* '^(n[ãa]o (informad[oa]|dit[oa]|mencionad[oa]|especificad[oa]|sei|informou|declarad[oa])|sem informa[çc][ãa]o|desconhecid[oa]|n/?a|nulo|null|none|-+|\?+)$';

-- ── checkpoints do LangGraph ─────────────────────────────────────────────
-- As tabelas nascem no primeiro `invoke` (PostgresSaver.setup()), então podem
-- não existir ainda — o mesmo guard que a rota /api/admin/forget usa.
--
-- DUAS PASSADAS, e a separação é o ponto — não é estilo.
--
-- As três tabelas do saver NÃO têm FK entre si (`checkpoint_blobs` é chaveada
-- por (thread_id, checkpoint_ns, channel, version) e nem referencia
-- `checkpoint_id`). Se cada tabela decidisse sozinha "existe gêmea sem '+'?",
-- elas poderiam decidir DIFERENTE para a mesma thread: apagar em `checkpoints`
-- e renomear em `checkpoint_blobs`, deixando blob órfão — ou o inverso,
-- deixando checkpoint apontando para versão de canal que sumiu.
--
-- Por isso: (1) a decisão é tomada UMA vez, sempre consultando `checkpoints`,
-- que é a tabela raiz; (2) TODOS os deletes acontecem antes de QUALQUER update.
-- Sem essa ordem, o rename em `checkpoints` criaria linhas sem '+' que a
-- passada seguinte leria como "a gêmea já existe" e apagaria indevidamente os
-- blobs que deveriam ter sido renomeados.
DO $$
DECLARE
  t text;
  tabelas text[] := ARRAY['checkpoints', 'checkpoint_blobs', 'checkpoint_writes'];
BEGIN
  -- As tabelas nascem no primeiro `invoke`; sem a raiz não há o que decidir.
  IF to_regclass('public.checkpoints') IS NULL THEN
    RETURN;
  END IF;

  -- Passada 1 — apagar a thread com '+' onde a sem '+' já existe.
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'DELETE FROM %I x WHERE x.thread_id LIKE ''%%:+%%''
           AND EXISTS (SELECT 1 FROM checkpoints c
                        WHERE c.thread_id = replace(x.thread_id, '':+'', '':''))',
        t
      );
    END IF;
  END LOOP;

  -- Passada 2 — o que sobrou não tem gêmea: renomear para a forma canônica.
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'UPDATE %I SET thread_id = replace(thread_id, '':+'', '':'')
          WHERE thread_id LIKE ''%%:+%%''',
        t
      );
    END IF;
  END LOOP;
END $$;
