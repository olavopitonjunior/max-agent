-- Alerta de avisos represados (05/10/2026, decisão do Olavo).
--
-- Aviso que não sai porque a janela de 24h da Meta está fechada e o template
-- do tipo não está aprovado fica represado (`template_pendente`); com 72h
-- expira (#50). Quando há represados há mais de 24h, o Max manda um e-mail
-- pelo receptor do ImobPro (`avisos_represados`) — no máximo UM por dia.
--
-- A trava mora no banco, e não na memória do processo: cada passada do cron é
-- uma function nova. É o último e-mail desse tipo que SAIU; o envio que falha
-- devolve o valor anterior, e a passada seguinte tenta de novo.
ALTER TABLE connection_state
  ADD COLUMN IF NOT EXISTS represados_notified_at timestamptz;
