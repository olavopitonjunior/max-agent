# Templates V5 (avisos fora da janela de 24h) — para submeter no Gerenciador

Cinco templates de resposta rápida que casam com os avisos de dentro da janela (texto A, botões B, marco C). Só saem quando a linha do outbox traz o `aviso` v1 e **todas** as ações dos botões estão em `aviso.acoes`; sem isso, o envio segue pelo template anterior (v4, v3, v2 ou v1), então nada muda até a Meta aprovar.

O toque em cada botão volta como `av:<id da linha>:<ação>` e cai no mesmo roteador dos botões da janela aberta (`src/lib/aviso-botao.ts`).

Regras comuns aos cinco: categoria **UTILITY**, idioma **pt_BR**, o **corpo exato** abaixo (o refresh compara o texto; qualquer diferença vira `DIVERGENTE` e o template não é usado), botões do tipo **Resposta rápida** na ordem listada, texto de botão sem emoji (até 20 caracteres).

## Como submeter

Quatro deles (sem imagem) podem ir pelo `templates-sync` (`--apply --only <nome>`) ou pelo Gerenciador. O `max_marco_v5` tem cabeçalho de imagem e **só vai pelo Gerenciador**: a Meta exige uma imagem de exemplo (`header_handle`, upload) e o sync não faz upload — ele pula o template com aviso. Atenção: `templates-sync --apply` sem `--only` submeteria os quatro sem imagem.

---

## 1. `max_negocio_andamento_v5` — nível A, andamento do negócio

- Nome: `max_negocio_andamento_v5` · Categoria: UTILITY · Idioma: pt_BR · Sem cabeçalho
- Corpo:

```
📌 Olá, {{1}}! Andamento na {{2}}: *{{3}}*. Negócio: *{{4}}*. Os detalhes estão no botão abaixo.
```

- Exemplos: `{{1}}` Ana · `{{2}}` RE/MAX Trio · `{{3}}` Status do negócio atualizado · `{{4}}` Venda Apto 302
- Botões (resposta rápida), na ordem:
  1. `Abrir negócio` (ação `abrir`)
- Kinds: `stage_change`, `deal_stage_change`
- Até aprovar: sai `max_negocio_andamento`.

## 2. `max_formulario_pendente_v5` — nível B, formulário com pendência

- Nome: `max_formulario_pendente_v5` · UTILITY · pt_BR · Sem cabeçalho
- Corpo:

```
⏳ Olá, {{1}}! Status do negócio *{{2}}* na {{3}}: formulário com respostas pendentes das partes. Os botões abaixo reenviam o link ou abrem o formulário.
```

- Exemplos: `{{1}}` Ana · `{{2}}` Venda Apto 302 · `{{3}}` RE/MAX Trio
- Botões (resposta rápida), na ordem:
  1. `Reenviar link` (ação `reenviar_link`)
  2. `Me lembra amanhã` (ação `lembrar_amanha`)
  3. `Ver formulário` (ação `ver_formulario`)
- Kinds: `form_reminder`, `deal_form_reminder`
- Só sai se o aviso trouxer as três ações (o `reenviar_link` com `alvoId`, e a linha com o negócio). Até aprovar: sai `max_formulario_pendente_v3` (depois v2, v1).

## 3. `max_proposta_v5` — nível B, status de proposta

- Nome: `max_proposta_v5` · UTILITY · pt_BR · Sem cabeçalho
- Corpo:

```
📝 Olá, {{1}}! Status de proposta na {{2}}: *{{3}}*. Veja os detalhes nos botões abaixo.
```

- Exemplos: `{{1}}` Ana · `{{2}}` RE/MAX Trio · `{{3}}` Proposta enviada para assinatura
- Botões (resposta rápida), na ordem:
  1. `Ver proposta` (ação `ver_proposta`)
  2. `Abrir negócio` (ação `abrir`)
- Kinds: `proposal_created_status`, `proposal_sent`, `proposal_delivered`
- Até aprovar: saem `max_proposta_status`, `max_proposta_enviada` e `max_proposta_entregue`, cada um no seu kind.

## 4. `max_atividades_v5` — nível B, atividades pendentes

- Nome: `max_atividades_v5` · UTILITY · pt_BR · Sem cabeçalho
- Corpo:

```
📋 Olá, {{1}}! Você tem *atividades pendentes* na {{2}}. Toque no botão abaixo para ver as atividades.
```

- Exemplos: `{{1}}` Ana · `{{2}}` RE/MAX Trio
- Botão (resposta rápida): `Ver atividades` (ação `abrir`: o toque devolve o link do aviso). Um só: na atividade a plataforma só oferece `abrir` enquanto `activity.write` estiver OFF.
- Kinds: `activity_assigned`, `activity_due`, `activity_due_soon`
- Segue "um por janela" (um aviso neutro por telefone), como o v1/v2. Não oferece `concluir` nem `adiar_1d` (dependem de `activity.write`, hoje OFF).
- Até aprovar: sai `max_atividades_pendentes_v2` (depois o v1).

## 5. `max_marco_v5` — nível C, marco com imagem

- Nome: `max_marco_v5` · UTILITY · pt_BR
- **Cabeçalho: Imagem.** Imagem de exemplo sugerida: a imagem de marco gerada pela plataforma (rota `/api/og/marco/[token]` do contractmaker), baixada de um marco real de staging, ou qualquer arte 1200x630 neutra. A imagem de exemplo é só para a análise; no envio real vai a de cada marco (`aviso.imagemUrl`).
- Corpo:

```
🎉 Olá, {{1}}! Marco na {{2}}: *{{3}}*. Os detalhes estão nos botões abaixo.
```

- Exemplos: `{{1}}` Ana · `{{2}}` RE/MAX Trio · `{{3}}` Contrato assinado
- Botões (resposta rápida), na ordem:
  1. `Abrir negócio` (ação `abrir`)
  2. `Próximo passo` (ação `criar_atividade`)
- Kinds: `contract_signed`, `contract_signed_status`
- Um template neutro para os marcos de contrato (o título e a imagem dizem qual é). `proposal_completed` fica fora: não é de um negócio e o v2 dele tem o botão "Converter" em negócio, que o V5 perderia. `captacao_signed_status` não tem V5 porque não está no catálogo (fora da régua).
- Só sai com `aviso.imagemUrl` https e as duas ações no aviso. Até aprovar (ou sem imagem): saem `max_contrato_assinado` e `max_assinatura_status`, cada um no seu kind.

---

## Checklist de submissão

- [ ] Gerenciador do WhatsApp (WABA da Fincasa): criar cada template com categoria **Utilidade**, idioma **Português (Brasil)**.
- [ ] Nome exatamente como na lista (letras minúsculas, `_`).
- [ ] Corpo copiado e colado sem mudar nada (emoji no começo, `*negrito*` nas variáveis, pontuação).
- [ ] Exemplo de cada variável preenchido (tabela acima).
- [ ] Botões: tipo **Resposta rápida**, textos e ordem como acima.
- [ ] `max_marco_v5`: cabeçalho **Imagem** com a imagem de exemplo.
- [ ] Não usar `templates-sync --apply` sem `--only`.
- [ ] Depois da aprovação, rodar `templates-sync --refresh` (ou esperar o cron de hora em hora): o status só vira APPROVED aqui se texto e botões (e o cabeçalho IMAGE do marco) conferem com o catálogo.
- [ ] Se a Meta reclassificar algum para MARKETING (o marco, por causa do 🎉 e da imagem, é o mais provável), o envio prefere o anterior aprovado que não seja MARKETING; vale decidir se mantém o V5 assim mesmo.
- [ ] Conferir no contractmaker que o `aviso` traz as ações exigidas por cada template (tabela de kinds acima); caso contrário o V5 não é usado e o aviso sai pelo template anterior.
