-- Ficha de crédito pelo Max (M2, 11/10/2026).
--
-- Turno da ficha grava `text = NULL` e `reply_text` redigido (sem CPF nem
-- valores). Se o envio falhar, a retentativa não pode mandar o texto redigido
-- à pessoa: com `sensivel`, ela manda uma frase fixa. A marca é explícita —
-- `text IS NULL` não serve, mídia também não tem texto. Aditiva.
ALTER TABLE inbound_queue
  ADD COLUMN IF NOT EXISTS sensivel boolean NOT NULL DEFAULT false;
