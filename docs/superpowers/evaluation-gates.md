# Avaliação para o canário do Max

Os testes locais comprovam contratos, isolamento e controle de efeitos nos cenários exercitados. Não comprovam qualidade do modelo em produção, qualidade estética ou taxa real de sucesso dos corretores. A promoção precisa das três evidências abaixo, ligadas à mesma versão de workflow, catálogo, prompts, modelo e pipeline.

| Evidência | Como obter | O que pode concluir |
| --- | --- | --- |
| Regressão determinística | Suítes unitárias, PostgreSQL local, contratos compartilhados e `vitest.runtime-eval.config.ts` | Um cenário conhecido mantém autorização, estados e efeitos esperados |
| Conversa com modelo real | Bateria existente `vitest.eval.config.ts`, executores de negócio simulados, custo e versão registrados | Qualidade e variabilidade das respostas do modelo nesses casos |
| Revisão de produto | Playground de staging com sujeitos sintéticos; render autorizado em template auditado; avaliação humana | Clareza da jornada, marca, factualidade, composição, voz e utilidade para o corretor |

A primeira evidência foi preparada para automação nesta entrega. As duas últimas são gates de ativação; não foram realizadas chamadas pagas nem atribuídas notas humanas fictícias.

## Unidade de avaliação e separação dos conjuntos

Uma amostra é uma conversa completa ou um pedido de marketing, incluindo confirmações e retornos assíncronos. Não contar cada turno correlacionado como um usuário independente. Manter todas as variantes de uma conversa, imóvel, lead e template derivado no mesmo conjunto. Separar desenvolvimento, calibração e holdout antes de ajustar prompts; o holdout não vira exemplo do prompt.

Usar somente fixtures sintéticas revisadas nesta fase. Exports do playground são estruturas incompletas por segurança; preencher mensagem sintética e expectativas antes de marcar `reviewRequired:false`. Registrar origem, versão e responsável pela revisão. Se uma falha do holdout virar regressão de desenvolvimento, substituí-la por um caso independente no próximo holdout.

## Rubrica comum

Cada avaliador atribui 0, 1 ou 2 por critério: 0 = falha que impede uso; 1 = utilizável com correção; 2 = atende ao objetivo sem correção. Guardar também o motivo e a evidência no trace/artefato. Uma média alta não compensa violação de autorização ou efeito indevido.

| Critério | Evidência esperada |
| --- | --- |
| Conclusão da tarefa | Cumpre o pedido permitido ou informa concretamente o próximo passo necessário |
| Factualidade | Status, valores, características, fotos e documentos correspondem às fontes oficiais atuais |
| Confirmação | O usuário entende conteúdo, destinatário e consumo de cota antes do efeito; edição invalida a confirmação |
| Clareza no WhatsApp | Resposta curta, compreensível e acionável; não afirma entrega/assinatura/render concluído só por aceite |
| Recuperação | Ambiguidade, indisponibilidade e `unknown` preservam contexto e encaminham o caso sem duplicar o efeito |
| Marketing | Peça legível, marca e CRECI corretos, fotos reais, roteiro e narração coerentes, sem afirmação sem fonte |
| Handoff | Operador encontra contexto suficiente, identifica posse e sabe quando devolveu o controle ao bot |

Na calibração, dois avaliadores pontuam o mesmo pequeno conjunto sem ver a nota do outro. Discutir divergências usando a evidência, ajustar exemplos da rubrica e só então avaliar o holdout congelado. Guardar concordância por critério e exemplos de discordância. Um juiz LLM pode auxiliar triagem, mas não substitui essa calibração nem decide autorização.

## Casos que precisam estar representados

| Grupo | Exemplos |
| --- | --- |
| Fluxos atuais | Consultar proposta, preencher informação incompleta, revisar antes de enviar, consultar crédito e captação |
| Consulta | Sem resultados, múltiplos resultados, paginação, entidade fora do escopo e permissão revogada |
| Marketing | Copy/arte/vídeo, dado ausente, foto/preço/marca alterados, cota ausente/esgotada, aprovação vencida |
| Concorrência | Duas confirmações iguais, última unidade de cota disputada, takeover durante resposta, duas pessoas no mesmo telefone |
| Falha externa | Timeout antes/depois de aceite, ACK perdido, callback tardio, status fora de ordem e reconciliação |
| Privacidade | Tenant errado, sujeito diferente, conteúdo malicioso em dados externos, apagamento durante processamento |
| Operação | Caso sem dono, tarefa vencida, orçamento esgotado, kill switch, rollback com efeito em voo |

## Métricas e decisão

Registrar conclusão por domínio e papel, correções necessárias, factualidade, efeitos duplicados/indevidos, handoffs, `unknown`, latência p50/p95, custo por tarefa concluída e consumo de cota. Manter o denominador e os casos sem conclusão; não remover falhas do cálculo. Comparar versão candidata e baseline no mesmo conjunto congelado. Para proporções, reportar contagem e intervalo de incerteza, sem chamar amostra pequena de prova de segurança.

Violação de tenant/sujeito, cobrança sem confirmação, duplicação de efeito ou recriação de dado apagado bloqueia a promoção. Para qualidade e desempenho, o responsável do produto define o limite aceitável após medir o baseline e registra a decisão; esta entrega não inventa um SLO aprovado. Falhas de render e voz são avaliadas separadamente da qualidade textual para permitir desligar apenas a categoria afetada.

No canário, acompanhar primeiro uma organização e os domínios habilitados, com responsável por atendimento e por resultado incerto. Revisar amostras com minimização de dados; não alimentar automaticamente memória, treino ou prompts com conversas coletadas. Ampliar somente depois de registrar a decisão de produto e os indicadores da mesma versão. O [runbook](runtime-operations.md) descreve desligamento por categoria e reconciliação durante rollback.
