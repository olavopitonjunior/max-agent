# Max — pacote de implementação

Este documento descreve o código desta branch, não uma implantação. A ativação depende do runbook, das permissões de cada organização e da validação em staging. O [workflow interativo](workflow/max-superpoderes.html) reúne a arquitetura entregue e a expansão planejada; o catálogo do runtime informa o que está instalado e habilitado.

## Fronteira da entrega

| Área | Implementação nesta entrega | Onde acompanhar |
| --- | --- | --- |
| Conversa e fluxos atuais | LangGraph existente, contexto por sujeito, tarefas/intents duráveis, orçamento, isolamento de memória e proteção no envio | Max `src/lib/runtime`, `src/graph`, `src/lib/inbound.ts` |
| Propostas, formulários, crédito e captação | Executores existentes preservados; confirmação, identidade e política continuam no servidor | Catálogo e trace por execução |
| Consultas | `notification.list`, `activity.list`, `metrics.get`, `property.list`, `property.detail`, `contract.status`, com projeção e paginação | `MAX_EXTENDED_QUERIES` e capabilities por organização |
| Atendimento humano | Fila, dono único, envio com controle de versão, resultado incerto e devolução explícita ao bot | ImobPro `/settings/max/atendimento` |
| Marketing | Brief, texto/roteiro, arte SVG, QA e vídeo assíncrono; marca/modelos/cotas governados; biblioteca pessoal | ImobPro `/marketing` e tools `marketing.*` |
| Administração | Catálogo real, indicadores, tarefas/intents incertos e cancelamento restrito a tarefas ainda em fila | `/admin/max/catalog`, `/admin/max/runtime` |
| Playground | Mesmo grafo, simulação sem efeitos, staging com identidade sintética permitida, histórico, trace e export para eval | `/admin/max/playground` |
| Avaliação | Replay determinístico com rede bloqueada, fixtures sintéticas e contratos compartilhados | `vitest.runtime-eval.config.ts`, `docs/contracts` |
| Expansão | Slots de catálogo para pesquisa/Deep Agents, agenda, documentos, locação e financeiro | `planned`, sem executor habilitado |

Não foi criado um microserviço por agente. Max coordena fluxos especializados; o pipeline de marketing executa workers determinísticos no ImobPro e emite seus eventos reais. Não há LLM criativo oculto nessa etapa. A integração MCP deve reutilizar os serviços autorizados; este pacote não instala MCPs externos nem transforma os itens futuros em tools executáveis.

## Mudanças visíveis no playground

O operador escolhe organização, pessoa, modo e sessão. A identidade efetiva vem do servidor. Simulação é o padrão; staging exige autorização explícita no ImobPro e allowlist de contatos sintéticos no Max. O trace mostra eventos emitidos pela execução, versões e passos de marketing reconhecidos. Sessões isoladas não acessam checkpoints do WhatsApp.

Exportar um eval não copia a conversa: gera estrutura de teste sem texto livre, argumentos ou identificadores. O autor insere conteúdo sintético, define expectativas e marca a revisão antes do replay. Esse ensaio mede roteamento e controle de efeitos. Qualidade conversacional e estética exigem rubrica e avaliação humana antes da ampliação do canário.

## Dependências de ativação

Aplicar as migrações e seguir a ordem do [runbook](runtime-operations.md). Os dois serviços precisam compartilhar os contratos `max-runtime-v1.json` e `max-marketing-v1.json`. Flags de runtime, handoff, marketing e consultas novas permanecem OFF até habilitação.

Vídeo exige credenciais próprias, template Creatomate auditado e fixado por hash, estimativa de custo que inclua narração, armazenamento privado e cota explícita. O custo técnico fica na administração; o corretor confirma uma unidade de sua cota. A conclusão proativa inicial usa o sino do ImobPro. Não foi habilitado envio proativo de conclusão de marketing pelo WhatsApp.

Artes são SVG com fotos reais referenciadas. Exportar uma imagem raster autocontida é uma evolução posterior; publicação social, avatar e editor livre também estão fora desta versão. Render real pago, validação estética e smoke com credenciais de staging permanecem gates da ativação, não resultados presumidos dos testes locais.

## Bases e reuso rastreável

| Repositório | Base da implementação | Destino da revisão |
| --- | --- | --- |
| Max | `26b4a4fbd140db249188af1ff6ceee5dd56dffc3` | `master` |
| ImobPro | `5f072bfb821f355393ab7af91f46acb00fb68c68` | `staging` |

As mudanças preexistentes nas duas cópias de trabalho originais foram preservadas; o trabalho acontece em worktrees `feat/max-superpowers`. Não há upgrade de LangGraph neste pacote.

O ImobPro registra em `docs/marketing/provenance.json` as adaptações do Rankd nos commits `867132f8215587a500e984285f0975d20ae21655` e `75c3ad628c4b4f28e4e4a59aa98b7871dc517528`, além das práticas de copy/edição do repositório `coreyhaines31/marketingskills` em `e85f3cbc2e4a79bf33b2a12e9bdd9087d414735b`, com aviso MIT. Não foram compartilhados banco, autenticação, usuários, faturamento ou chaves do Rankd.

## Antes de promover

1. Conferir as verificações registradas nas PRs coordenadas e aplicar as migrações numa base de staging com restauração ensaiada.
2. Validar permissões e isolamento com dois tenants, dois sujeitos e contatos sintéticos; testar perda de ACK, takeover, apagamento e revogação durante execução.
3. Configurar marca, template e cota de teste; revisar texto, composição, narração, custo e tempo de um render autorizado em staging.
4. Definir responsáveis pelo atendimento, por jobs `unknown`, por alertas e pelo canário. Resultado incerto não autoriza repetir cobrança ou envio.
5. Promover por organização após aprovação humana; manter receptores e reconciliação ativos durante rollback.

O pacote não configura ambiente remoto, não aplica migração em produção e não promove as branches automaticamente.

As verificações finais e os commits de código validados estão em [validation.md](validation.md).
