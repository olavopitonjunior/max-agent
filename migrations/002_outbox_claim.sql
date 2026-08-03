-- Claim do outbox precisa TIRAR a linha do conjunto elegível.
--
-- Bug encontrado em 2026-08-03 rodando os testes de integração em paralelo:
-- duas execuções concorrentes de `dispatchDue()` despacharam a MESMA linha
-- (`attempts` chegou a 2). Não era artefato de teste — é o que aconteceria com
-- dois crons sobrepostos na Vercel, que manda a mesma mensagem duas vezes pro
-- destinatário.
--
-- Por que `FOR UPDATE SKIP LOCKED` sozinho não bastava: ele segura o lock
-- apenas enquanto o STATEMENT roda. Como o claim e o envio são statements
-- separados (e cada um roda em transação implícita própria), entre um e outro a
-- linha volta a ficar destravada, `status='pending'` e `deliver_after` vencido —
-- ou seja, elegível de novo. A segunda execução a reivindicava legitimamente.
--
-- A correção é o mesmo padrão do `UserNotificationDelivery` do ImobPro:
-- claim-first com mudança de estado, e recuperação do claim órfão por tempo.
-- `sending` é estado transitório: quem morre entre o claim e o envio deixa a
-- linha ali, e o `last_attempt_at` permite reivindicá-la de volta.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- O índice de varredura passa a cobrir os dois estados reivindicáveis.
DROP INDEX IF EXISTS outbox_due_idx;

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON outbox (status, deliver_after)
  WHERE status IN ('pending', 'sending');
