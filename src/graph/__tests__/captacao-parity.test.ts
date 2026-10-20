import { describe, it, expect } from "vitest";
import {
  CODIGOS_DA_AUTORIZACAO,
  CODIGOS_DO_ENVIO,
  TEXTO_POR_CODIGO,
  TEXTO_POR_CODIGO_AUTORIZACAO,
  lerAutorizacaoDecisao,
  lerAutorizacaoPedido,
  lerCampoDeOpcoes,
  lerCanalPadrao,
  lerFilaDeAutorizacoes,
  lerItemDaCaptacao,
  lerItemDaFilaDeAutorizacao,
  lerPreflight,
  textoDaFilaDeAutorizacoes,
  textoDaLista,
  textoDoCodigoDeAutorizacao,
  textoDoCodigoDeEnvio,
  textoDoItemDaCaptacao,
  textoDoItemDaFila,
  textoDoPreflight,
  tipoDoFaltante,
} from "../captacao";

/**
 * Vetores fixos do contrato dos verbos de captação (`docs/max.md` §18.12) — a
 * metade daqui. A outra é
 * `contractmaker/apps/web/src/lib/max/__tests__/captacao-parity.test.ts`, com
 * estes MESMOS literais (`captacao-vectors.ts` lá). Regra 1 da governança do
 * Max: mudança de contrato exige teste de vetor fixo dos dois lados.
 *
 * ── Por que não basta "parsear e comparar" ────────────────────────────────
 *
 * O modo de falha deste contrato é SILENCIOSO: se o ImobPro renomear
 * `proprietarios` para `donos`, este lado lê `undefined`, o fail-closed devolve
 * o item sem donos e nenhum teste fica vermelho. Por isso, como no vetor da
 * política (§11.5), o vetor é parseado do JSON CRU e cada chave é REMOVIDA por
 * vez: o texto que o Max produz tem que MUDAR. Se não mudar, aquela chave não
 * está sendo lida — que é exatamente o estado em que uma renomeação nos deixaria.
 *
 * Os literais são literais de propósito, e não montados a partir dos tipos:
 * um fixture derivado do código acompanharia a renomeação em silêncio.
 *
 * ── v2/PR5 (captação, aditivo) ─────────────────────────────────────────────
 *
 * `PREFLIGHT_SERIALIZADO` passou a ser o vetor NOVO (com `tipo`/`nivel`/
 * `lista`/`opcoes` em cada faltante e `pendentesFicha[]`), espelhando o que
 * `captacao-vectors.ts` exporta agora do lado do ImobPro. O vetor ANTIGO (sem
 * esses campos) continua testado como `PREFLIGHT_SERIALIZADO_ANTIGO`: é a
 * forma que staging/prod ainda respondem até o PR5 do ImobPro ser promovido —
 * `lerPreflight` e a pergunta por `tipoDoFaltante` têm que continuar lendo
 * essa forma exatamente como antes (fallback por `TIPO_DO_PATH`).
 *
 * Os campos novos (`tipo`, `nivel`, `lista`, `opcoes`, `pendentesFicha`, `ref`
 * de bloqueio) ainda não alimentam nenhum texto — a única mudança de
 * comportamento desta PR é `tipoDoFaltante` preferir o `tipo` do servidor ao
 * `TIPO_DO_PATH` fixo. Por isso a prova de leitura desses campos novos é
 * estrutural (o objeto que `lerPreflight`/`lerCampoDeOpcoes` devolve muda),
 * não textual.
 */

const ITEM_COM_DONOS_SERIALIZADO =
  '{"ref":1,"id":"cap-1","codigo":"CAP-2026-0007","nome":"Apto da Dona Maria","esteira":"venda",' +
  '"estado":"Vence em 12 dias","tom":"warning","endereco":"Rua Augusta, 1250 — ap 42",' +
  '"atualizadoEm":"2026-10-16T13:00:00.000Z","link":"/imoveis/captacoes/cap-1","proprietarios":["Maria Silva"]}';
const ITEM_SEM_DONOS_SERIALIZADO =
  '{"ref":1,"id":"cap-1","codigo":"CAP-2026-0007","nome":"Apto da Dona Maria","esteira":"venda",' +
  '"estado":"Vence em 12 dias","tom":"warning","endereco":"Rua Augusta, 1250 — ap 42",' +
  '"atualizadoEm":"2026-10-16T13:00:00.000Z","link":"/imoveis/captacoes/cap-1"}';

/** Forma ANTIGA (ainda sem v2/PR5), tal como staging/prod respondem hoje. */
const PREFLIGHT_SERIALIZADO_ANTIGO =
  '{"pronto":false,"faltantes":[{"path":"imovel.matricula","rotulo":"Matrícula","etapa":"imovel"},' +
  '{"path":"proprietarios[].cpf","rotulo":"CPF","etapa":"proprietarios","proprietarioId":"p1"}],' +
  '"bloqueios":[{"codigo":"soma_percentuais"}],"emBranco":1}';

/**
 * v2/PR5 (copiado byte a byte de `captacao-vectors.ts`, `PREFLIGHT_SERIALIZADO`):
 * cada faltante com `tipo`/`nivel` (e `lista`/`opcoes`), mais `pendentesFicha[]`.
 */
const PREFLIGHT_SERIALIZADO =
  '{"pronto":false,"faltantes":[{"path":"imovel.matricula","rotulo":"Matrícula","etapa":"imovel","tipo":"texto","nivel":"envio"},' +
  '{"path":"proprietarios[].cpf","rotulo":"CPF","etapa":"proprietarios","proprietarioId":"p1","tipo":"cpf","nivel":"envio","lista":"proprietarios"},' +
  '{"path":"locacao.garantias_aceitas","rotulo":"Garantias aceitas","etapa":"condicoes","tipo":"lista_opcoes","nivel":"envio",' +
  '"opcoes":[{"valor":"caucao","label":"Caução"},{"valor":"sem_garantia","label":"Sem garantia"}]}],' +
  '"pendentesFicha":[{"path":"imovel.area","rotulo":"Área","etapa":"imovel","tipo":"decimal","nivel":"ficha"}],' +
  '"bloqueios":[{"codigo":"soma_percentuais"}],"emBranco":1}';

/** v2/PR4, só ganhou `pendentesFicha` no PR5: bloqueio de autorização, `ref` é id, sem dado nenhum. */
const PREFLIGHT_AUTORIZACAO_SERIALIZADO =
  '{"pronto":false,"faltantes":[],"pendentesFicha":[],"bloqueios":[{"codigo":"proprietario_aguarda_autorizacao","ref":"p1"},' +
  '{"codigo":"imovel_autorizacao_negada","ref":"prop-9"}],"emBranco":0}';

/** Item de `campos[]` de `captacao.options` (v2/PR5): campo de lista fechada. */
const CAMPO_DE_LISTA_SERIALIZADO =
  '{"path":"locacao.garantias_aceitas","rotulo":"Garantias aceitas","tipo":"lista_opcoes","nivel":"envio",' +
  '"opcoes":[{"valor":"caucao","label":"Caução"},{"valor":"sem_garantia","label":"Sem garantia"}]}';
/** Item de `campos[]` de `captacao.options` (v2/PR5): campo por pessoa. */
const CAMPO_POR_PESSOA_SERIALIZADO =
  '{"path":"proprietarios[].cpf","rotulo":"CPF","tipo":"cpf","nivel":"envio","lista":"proprietarios"}';

const CODIGOS_DO_ENVIO_LITERAL = [
  "pendencias", "confirmar_brancos", "clicksign_nao_conectada", "aceite_desabilitado", "contato_invalido",
  "ninguem_assina", "arquivada", "ja_enviando", "ja_cancelando", "versao_desatualizada", "limite_do_plano",
  "google_reconectar", "previa", "bloco_repetivel", "whatsapp_indisponivel", "falha_envio", "cota_diaria",
  "muitas_tentativas",
];

/** O que o Max NUNCA recebe do ImobPro numa captação (regra 5): dado pessoal, bancário e o `dataJson`. */
const CHAVES_PROIBIDAS_AO_MAX = [
  "cpf", "cnpj", "rg", "email", "telefone", "telefone1", "telefone2", "banco", "agencia", "conta", "pix_chave",
  "data_nascimento", "dataJson", "token", "url", "documentoUrl", "pdfUrl",
];

const NOMES = { p1: "Maria Silva" };

function chavesProfundas(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => chavesProfundas(x, acc));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { acc.push(k); chavesProfundas(x, acc); }
  }
  return acc;
}

/** Caminhos de todas as chaves ("faltantes.1.proprietarioId"), para remover uma por vez. */
function caminhos(v: unknown, prefixo: string[] = [], acc: string[][] = []): string[][] {
  if (Array.isArray(v)) v.forEach((x, i) => caminhos(x, [...prefixo, String(i)], acc));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { acc.push([...prefixo, k]); caminhos(x, [...prefixo, k], acc); }
  }
  return acc;
}

function semChave<T>(raw: string, caminho: string[]): T {
  const copia = JSON.parse(raw) as Record<string, unknown>;
  let alvo: unknown = copia;
  for (const k of caminho.slice(0, -1)) alvo = (alvo as Record<string, unknown>)[k];
  delete (alvo as Record<string, unknown>)[caminho[caminho.length - 1]!];
  return copia as T;
}

describe("paridade: códigos do envio (lado max-agent)", () => {
  it("a lista de códigos é a literal do ImobPro, na mesma ordem", () => {
    expect([...CODIGOS_DO_ENVIO]).toEqual(CODIGOS_DO_ENVIO_LITERAL);
  });

  it("o mapa de texto cobre exatamente esses códigos, na mesma ordem", () => {
    expect(Object.keys(TEXTO_POR_CODIGO)).toEqual(CODIGOS_DO_ENVIO_LITERAL);
  });

  it("todo código tem texto próprio em português, sem 'undefined' e sem nome de pessoa", () => {
    const link = "https://imobpro.ia.br/imoveis/captacoes/cap-1";
    const textos = CODIGOS_DO_ENVIO_LITERAL.map((c) => textoDoCodigoDeEnvio(c, { link, emBranco: 2, limite: 10 }));
    for (const t of textos) {
      expect(t.length).toBeGreaterThan(15);
      expect(t).not.toContain("undefined");
      expect(t).not.toContain("Maria");
    }
    // Cada código diz uma coisa diferente: dois iguais seriam código sem texto.
    expect(new Set(textos).size).toBe(textos.length);
  });

  it("código desconhecido vira texto neutro mais o link, nunca o que o servidor escreveu", () => {
    const link = "https://imobpro.ia.br/imoveis/captacoes/cap-1";
    const t = textoDoCodigoDeEnvio("codigo_do_futuro", { link });
    expect(t).toContain(link);
    expect(t).not.toContain("codigo_do_futuro");
    expect(t).toBe(textoDoCodigoDeEnvio("outro_codigo_qualquer", { link }));
  });

  it("versao_desatualizada e confirmar_brancos têm o texto combinado no contrato", () => {
    expect(TEXTO_POR_CODIGO.versao_desatualizada({ link: "" })).toBe("Alguém mudou a captação na tela; vou conferir de novo.");
    const t = TEXTO_POR_CODIGO.confirmar_brancos({ link: "", emBranco: 3 });
    expect(t).toContain("3 campo(s) vão em branco");
    expect(t).toContain("enviar assim mesmo");
  });
});

describe("paridade: item de captacao.list (lado max-agent)", () => {
  it("parseia o vetor serializado exatamente como o ImobPro o emite", () => {
    const item = lerItemDaCaptacao(JSON.parse(ITEM_COM_DONOS_SERIALIZADO));
    expect(item).toEqual({
      ref: 1, id: "cap-1", codigo: "CAP-2026-0007", nome: "Apto da Dona Maria", esteira: "venda",
      estado: "Vence em 12 dias", tom: "warning", endereco: "Rua Augusta, 1250 — ap 42",
      atualizadoEm: "2026-10-16T13:00:00.000Z", link: "/imoveis/captacoes/cap-1", proprietarios: ["Maria Silva"],
    });
    const texto = textoDoItemDaCaptacao(item!);
    expect(texto).toContain("1. CAP-2026-0007 — Apto da Dona Maria (venda) · Vence em 12 dias");
    expect(texto).toContain("Rua Augusta, 1250 — ap 42");
    expect(texto).toContain("Proprietários: Maria Silva");
    expect(texto).toContain("https://imobpro.ia.br/imoveis/captacoes/cap-1");
  });

  it("o item SEM donos não diz nada de proprietário", () => {
    const item = lerItemDaCaptacao(JSON.parse(ITEM_SEM_DONOS_SERIALIZADO));
    expect(item?.proprietarios).toBeNull();
    expect(textoDoItemDaCaptacao(item!)).not.toContain("Proprietários");
    // "Dona Maria" está no NOME da captação (o que a pessoa disse); o dono "Maria Silva" não vem.
    expect(textoDoItemDaCaptacao(item!)).not.toContain("Maria Silva");
  });

  it("os vetores NÃO carregam nenhuma chave proibida (ausência, não presença)", () => {
    for (const vetor of [ITEM_COM_DONOS_SERIALIZADO, ITEM_SEM_DONOS_SERIALIZADO, PREFLIGHT_SERIALIZADO, PREFLIGHT_AUTORIZACAO_SERIALIZADO]) {
      const chaves = chavesProfundas(JSON.parse(vetor));
      for (const proibida of CHAVES_PROIBIDAS_AO_MAX) {
        expect(chaves, proibida).not.toContain(proibida);
        // Chave (não valor): v2/PR5 usa "cpf"/"email"/"telefone" como VALOR de `tipo` do
        // catálogo (ex.: "tipo":"cpf"), o que é esperado e não é o dado em si.
        expect(vetor).not.toContain(`"${proibida}":`);
      }
      expect(vetor).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    }
  });

  it("defesa em profundidade: chave que o servidor vazar não chega ao texto", () => {
    const vazado = {
      ...JSON.parse(ITEM_SEM_DONOS_SERIALIZADO),
      cpf: "11144477735", email: "maria@ex.com", telefone1: "11987654321", dataJson: { x: 1 }, pix_chave: "chave-secreta",
    };
    const texto = textoDaLista([vazado], 1);
    for (const valor of ["11144477735", "maria@ex.com", "11987654321", "chave-secreta"]) expect(texto).not.toContain(valor);
  });

  it.each(caminhos(JSON.parse(ITEM_COM_DONOS_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda o texto — prova que a chave é LIDA",
    (caminho) => {
      const completo = textoDaLista([JSON.parse(ITEM_COM_DONOS_SERIALIZADO)], 1);
      const mutilado = textoDaLista([semChave(ITEM_COM_DONOS_SERIALIZADO, caminho.split("."))], 1);
      expect(mutilado).not.toBe(completo);
    }
  );
});

describe("compatibilidade: preflight na forma ANTIGA (sem tipo/nível/pendentesFicha) — como staging/prod respondem hoje", () => {
  it("parseia o vetor e o texto liga o proprietário ao nome do fluxo", () => {
    const raw = JSON.parse(PREFLIGHT_SERIALIZADO_ANTIGO);
    expect(lerPreflight(raw)).toEqual({
      pronto: false,
      faltantes: [
        { path: "imovel.matricula", rotulo: "Matrícula", etapa: "imovel" },
        { path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: "p1" },
      ],
      pendentesFicha: [],
      bloqueios: [{ codigo: "soma_percentuais" }],
      emBranco: 1,
      version: null,
    });
    const texto = textoDoPreflight(raw, NOMES);
    expect(texto).toContain("Matrícula (imóvel)");
    expect(texto).toContain("CPF de Maria Silva (proprietários)");
    expect(texto).toContain("a soma dos percentuais dos proprietários não fecha 100%");
    expect(texto).toContain("1 campo(s) vão em branco no contrato");
  });

  it("sem `tipo` do servidor, TIPO_DO_PATH ainda decide a pergunta (fallback) — comportamento de antes preservado", () => {
    const pf = lerPreflight(JSON.parse(PREFLIGHT_SERIALIZADO_ANTIGO))!;
    expect(tipoDoFaltante(pf.faltantes[0]!)).toBe("texto"); // imovel.matricula
    expect(tipoDoFaltante(pf.faltantes[1]!)).toBe("doc"); // proprietarios[].cpf
  });

  it("o preflight nunca traz valor nem nome: o texto só usa o nome que o FLUXO guardou", () => {
    const texto = textoDoPreflight(JSON.parse(PREFLIGHT_SERIALIZADO_ANTIGO), {});
    expect(texto).not.toContain("Maria");
    expect(texto).toContain("CPF");
  });

  it("pronto sem pendência diz que está tudo preenchido", () => {
    expect(textoDoPreflight({ pronto: true, faltantes: [], bloqueios: [], emBranco: 0 })).toBe("Tudo preenchido para o envio.");
  });

  it("resposta sem `pronto` booleano não é lida (fail-closed), em vez de virar 'pronto'", () => {
    expect(lerPreflight({ faltantes: [] })).toBeNull();
    expect(textoDoPreflight({ faltantes: [] })).toBe("Não consegui ler a conferência da captação.");
  });

  it.each(caminhos(JSON.parse(PREFLIGHT_SERIALIZADO_ANTIGO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda o texto — prova que a chave é LIDA",
    (caminho) => {
      const completo = textoDoPreflight(JSON.parse(PREFLIGHT_SERIALIZADO_ANTIGO), NOMES);
      const mutilado = textoDoPreflight(semChave(PREFLIGHT_SERIALIZADO_ANTIGO, caminho.split(".")), NOMES);
      expect(mutilado).not.toBe(completo);
    }
  );
});

describe("paridade: preflight v2/PR5 — tipo, nível, lista, opções, pendentesFicha e ref de bloqueio", () => {
  it("lerPreflight lê tipo/nível/lista/opções de cada faltante e o pendentesFicha", () => {
    expect(lerPreflight(JSON.parse(PREFLIGHT_SERIALIZADO))).toEqual({
      pronto: false,
      faltantes: [
        { path: "imovel.matricula", rotulo: "Matrícula", etapa: "imovel", tipo: "texto", nivel: "envio" },
        {
          path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: "p1",
          tipo: "cpf", nivel: "envio", lista: "proprietarios",
        },
        {
          path: "locacao.garantias_aceitas", rotulo: "Garantias aceitas", etapa: "condicoes", tipo: "lista_opcoes", nivel: "envio",
          opcoes: [{ valor: "caucao", label: "Caução" }, { valor: "sem_garantia", label: "Sem garantia" }],
        },
      ],
      pendentesFicha: [
        { path: "imovel.area", rotulo: "Área", etapa: "imovel", tipo: "decimal", nivel: "ficha" },
      ],
      bloqueios: [{ codigo: "soma_percentuais" }],
      emBranco: 1,
      version: null,
    });
  });

  it("o texto da conferência continua igual (pendentesFicha e tipo/nível ainda não viram texto nesta preparação)", () => {
    const raw = JSON.parse(PREFLIGHT_SERIALIZADO);
    const texto = textoDoPreflight({ ...raw, bloqueios: [], emBranco: 0 }, NOMES);
    expect(texto).toContain("Matrícula (imóvel)");
    expect(texto).toContain("CPF de Maria Silva (proprietários)");
    expect(texto).toContain("Garantias aceitas (condições)");
    expect(texto).not.toContain("Área"); // pendentesFicha: informativo, não bloqueia nem aparece ainda.
  });

  it("pendentesFicha nunca bloqueia nem muda `pronto`: um rascunho `pronto:true` com pendentesFicha segue pronto", () => {
    const raw = { pronto: true, faltantes: [], pendentesFicha: [{ path: "imovel.area", rotulo: "Área", etapa: "imovel", tipo: "decimal", nivel: "ficha" }], bloqueios: [], emBranco: 0 };
    const pf = lerPreflight(raw)!;
    expect(pf.pronto).toBe(true);
    expect(pf.pendentesFicha).toHaveLength(1);
    expect(textoDoPreflight(raw)).toBe("Tudo preenchido para o envio.");
  });

  it("bloqueio de autorização traz `ref` como id, sem dado nenhum, e `pendentesFicha` vazio", () => {
    expect(lerPreflight(JSON.parse(PREFLIGHT_AUTORIZACAO_SERIALIZADO))).toEqual({
      pronto: false,
      faltantes: [],
      pendentesFicha: [],
      bloqueios: [
        { codigo: "proprietario_aguarda_autorizacao", ref: "p1" },
        { codigo: "imovel_autorizacao_negada", ref: "prop-9" },
      ],
      emBranco: 0,
      version: null,
    });
  });

  it.each(caminhos(JSON.parse(PREFLIGHT_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda a ESTRUTURA lida por lerPreflight — prova que a chave é LIDA",
    (caminho) => {
      const completo = lerPreflight(JSON.parse(PREFLIGHT_SERIALIZADO));
      const mutilado = lerPreflight(semChave(PREFLIGHT_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );

  it.each(
    // Só os caminhos de `bloqueios`: `faltantes`/`pendentesFicha`/`emBranco` já nascem no
    // valor-padrão deste vetor (vazio/zero), então removê-los não mudaria nada — o que
    // provaria menos, não mais, sobre a leitura.
    caminhos(JSON.parse(PREFLIGHT_AUTORIZACAO_SERIALIZADO)).map((c) => c.join(".")).filter((c) => c.startsWith("bloqueios")).map((c) => [c] as const)
  )(
    "remover `%s` do bloqueio de autorização muda a estrutura lida — prova que `ref` é LIDO",
    (caminho) => {
      const completo = lerPreflight(JSON.parse(PREFLIGHT_AUTORIZACAO_SERIALIZADO));
      const mutilado = lerPreflight(semChave(PREFLIGHT_AUTORIZACAO_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );
});

describe("paridade: tipoDoFaltante IGNORA o `tipo` do servidor — TIPO_DO_PATH decide sozinho (fix B1/B2)", () => {
  // Valores de `tipo` abaixo copiados do catálogo REAL do CM
  // (contractmaker apps/web/src/lib/captacao/field-catalog.ts): ele manda
  // "texto" genérico pra estes paths — o Max tem tipo especializado pra eles.
  it("imovel.endereco: CM manda tipo:\"texto\", mas o Max mantém \"endereco_imovel\" (pergunta/escrita especializada, não genérica)", () => {
    expect(tipoDoFaltante({ path: "imovel.endereco", rotulo: "Endereço do imóvel", tipo: "texto" })).toBe("endereco_imovel");
  });

  it("imovel.tipo: CM manda tipo:\"texto\", mas o Max mantém \"tipo_imovel\" — continua escrevendo imovel.kind, não um texto solto", () => {
    expect(tipoDoFaltante({ path: "imovel.tipo", rotulo: "Tipo do imóvel", tipo: "texto" })).toBe("tipo_imovel");
  });

  it("proprietarios[].nome / estado_civil / endereco_completo: CM manda tipo:\"texto\", mas o Max mantém os tipos especializados", () => {
    expect(tipoDoFaltante({ path: "proprietarios[].nome", rotulo: "Nome completo", tipo: "texto" })).toBe("nome");
    expect(tipoDoFaltante({ path: "proprietarios[].estado_civil", rotulo: "Estado civil", tipo: "texto" })).toBe("estado_civil");
    expect(tipoDoFaltante({ path: "proprietarios[].endereco_completo", rotulo: "Endereço do proprietário", tipo: "texto" })).toBe("endereco_pessoa");
  });

  it("path desconhecido vai pra tela mesmo com `tipo` do servidor presente — nenhum tipo novo é inventado via catálogo do servidor (prova do fix B2)", () => {
    expect(tipoDoFaltante({ path: "qualquer.caminho.novo", rotulo: "x", tipo: "cnpj" })).toBeUndefined();
    expect(tipoDoFaltante({ path: "qualquer.caminho.novo", rotulo: "x", tipo: "texto" })).toBeUndefined();
  });

  it("`lista_opcoes` cai pra tela, com ou sem `tipo` — nenhuma pergunta nova", () => {
    expect(tipoDoFaltante({ path: "locacao.garantias_aceitas", rotulo: "x", tipo: "lista_opcoes" })).toBeUndefined();
  });

  it("caminho conhecido sem `tipo` do servidor (resposta antiga) continua igual", () => {
    expect(tipoDoFaltante({ path: "imovel.matricula", rotulo: "x" })).toBe("texto");
    expect(tipoDoFaltante({ path: "proprietarios[].cpf", rotulo: "x" })).toBe("doc");
  });

  it("caminho desconhecido sem `tipo` nenhum cai pra tela, sem inventar", () => {
    expect(tipoDoFaltante({ path: "caminho.desconhecido", rotulo: "x" })).toBeUndefined();
  });

  it("regressão: no vetor novo PREFLIGHT_SERIALIZADO, o conjunto pergunta×tela é o MESMO com ou sem tipo/nível/lista/opções — exatamente o que origin/staging produziria para os mesmos paths sem `tipo`", () => {
    const pf = lerPreflight(JSON.parse(PREFLIGHT_SERIALIZADO))!;
    const semCatalogo = pf.faltantes.map(({ path, rotulo, etapa, proprietarioId }) => ({
      path, rotulo, ...(etapa ? { etapa } : {}), ...(proprietarioId ? { proprietarioId } : {}),
    }));
    const pathsPerguntaveisComCatalogo = pf.faltantes.filter((x) => tipoDoFaltante(x)).map((x) => x.path);
    const pathsPerguntaveisSemCatalogo = semCatalogo.filter((x) => tipoDoFaltante(x)).map((x) => x.path);
    const pathsDaTelaComCatalogo = pf.faltantes.filter((x) => !tipoDoFaltante(x)).map((x) => x.path);
    const pathsDaTelaSemCatalogo = semCatalogo.filter((x) => !tipoDoFaltante(x)).map((x) => x.path);
    expect(pathsPerguntaveisComCatalogo).toEqual(pathsPerguntaveisSemCatalogo);
    expect(pathsDaTelaComCatalogo).toEqual(pathsDaTelaSemCatalogo);
    // imovel.matricula ("texto") e proprietarios[].cpf ("cpf") estão em TIPO_DO_PATH: perguntáveis.
    // locacao.garantias_aceitas ("lista_opcoes") não está: vai pra tela, mesmo com `tipo` presente.
    expect(pathsPerguntaveisComCatalogo).toEqual(["imovel.matricula", "proprietarios[].cpf"]);
    expect(pathsDaTelaComCatalogo).toEqual(["locacao.garantias_aceitas"]);
  });
});

describe("paridade: campo de captacao.options — campos[] (v2/PR5, preparação)", () => {
  it("lê campo por pessoa (lista) e campo de lista fechada (opções), exatamente como o ImobPro emite", () => {
    expect(lerCampoDeOpcoes(JSON.parse(CAMPO_DE_LISTA_SERIALIZADO))).toEqual({
      path: "locacao.garantias_aceitas", rotulo: "Garantias aceitas", tipo: "lista_opcoes", nivel: "envio",
      opcoes: [{ valor: "caucao", label: "Caução" }, { valor: "sem_garantia", label: "Sem garantia" }],
    });
    expect(lerCampoDeOpcoes(JSON.parse(CAMPO_POR_PESSOA_SERIALIZADO))).toEqual({
      path: "proprietarios[].cpf", rotulo: "CPF", tipo: "cpf", nivel: "envio", lista: "proprietarios",
    });
  });

  it("sem path/rotulo/tipo/nivel não é lido (fail-closed)", () => {
    expect(lerCampoDeOpcoes({})).toBeNull();
    expect(lerCampoDeOpcoes({ path: "x", rotulo: "y" })).toBeNull();
  });

  it.each(caminhos(JSON.parse(CAMPO_DE_LISTA_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda a estrutura lida — prova que a chave é LIDA (campo de lista)",
    (caminho) => {
      const completo = lerCampoDeOpcoes(JSON.parse(CAMPO_DE_LISTA_SERIALIZADO));
      const mutilado = lerCampoDeOpcoes(semChave(CAMPO_DE_LISTA_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );

  it.each(caminhos(JSON.parse(CAMPO_POR_PESSOA_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda a estrutura lida — prova que a chave é LIDA (campo por pessoa)",
    (caminho) => {
      const completo = lerCampoDeOpcoes(JSON.parse(CAMPO_POR_PESSOA_SERIALIZADO));
      const mutilado = lerCampoDeOpcoes(semChave(CAMPO_POR_PESSOA_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );
});

describe("paridade: canalPadrao de captacao.options (v2/PR5, preparação — ainda não lido em nenhum fluxo)", () => {
  it("lê um canal válido", () => {
    expect(lerCanalPadrao({ canalPadrao: "email" })).toBe("email");
    expect(lerCanalPadrao({ canalPadrao: "whatsapp" })).toBe("whatsapp");
    expect(lerCanalPadrao({ canalPadrao: "aceite" })).toBe("aceite");
  });

  it("sem canalPadrao, ou com valor fora do catálogo, devolve null (fail-closed)", () => {
    expect(lerCanalPadrao({})).toBeNull();
    expect(lerCanalPadrao({ canalPadrao: "pombo-correio" })).toBeNull();
  });
});

/**
 * v2/PR7 (par do contractmaker#1863, PR#86): autorização de reaproveitamento pelo Max.
 * Literais COPIADOS BYTE A BYTE de `captacao-vectors.ts` do contractmaker — nunca
 * importados (regra 1 da governança do Max). `AUTORIZACAO_PEDIDO`/`AUTORIZACAO_DECISAO`
 * e `FILA_DE_AUTORIZACOES` (ambos em `docs/max.md` §18.12) ficam de lado como referência
 * do que o servidor NUNCA manda ao Max — nome, CPF inteiro, motivo, corretor dono.
 */
const AUTORIZACAO_PEDIDO_SERIALIZADO =
  '{"autorizacao":{"id":"aut-1","status":"pendente"},"tipo":"proprietario","ref":"p1"}';

const AUTORIZACOES_LISTA_SERIALIZADO =
  '{"items":[{"ref":1,"id":"aut-1","tipo":"proprietario","codigo":"CAP-2026-0007","solicitante":"Ana Souza",' +
  '"documento":"***.456.789-**","criadoEm":"2026-10-19T12:00:00.000Z","justificativa":"Cliente pediu para eu atender"},' +
  '{"ref":2,"id":"aut-2","tipo":"imovel","codigo":"CAP-2026-0008","solicitante":"Bruno Lima",' +
  '"imovel":"Rua Augusta, 1250","criadoEm":"2026-10-19T13:30:00.000Z"}],"total":2}';

const AUTORIZACAO_DECISAO_SERIALIZADO = '{"autorizacao":{"id":"aut-1","status":"aprovada"}}';

/** Lista fechada de `CODIGOS_DE_ERRO_DA_AUTORIZACAO`, mesma ordem do ImobPro. */
const CODIGOS_DA_AUTORIZACAO_LITERAL = [
  "tipo_invalido", "ref_obrigatorio", "captacao_id_obrigatorio", "justificativa_grande", "nao_e_rascunho",
  "nao_precisa_autorizacao", "documento_invalido", "pedido_invalido", "autorizacao_id_obrigatorio",
  "decisao_invalida", "motivo_obrigatorio", "nao_pendente", "solicitante_nao_decide",
  "motivo_grande",
];

describe("paridade: captacao.autorizacao.pedir (lado max-agent)", () => {
  it("lê autorização, tipo e ref exatamente como o ImobPro emite — sem nome, CPF, motivo nem outro corretor", () => {
    const lido = lerAutorizacaoPedido(JSON.parse(AUTORIZACAO_PEDIDO_SERIALIZADO));
    expect(lido).toEqual({ id: "aut-1", status: "pendente", tipo: "proprietario", ref: "p1" });
  });

  it("sem autorização.id/status ou tipo/ref não é lido (fail-closed)", () => {
    expect(lerAutorizacaoPedido({})).toBeNull();
    expect(lerAutorizacaoPedido({ autorizacao: { id: "x" }, tipo: "proprietario", ref: "p1" })).toBeNull();
  });

  it.each(caminhos(JSON.parse(AUTORIZACAO_PEDIDO_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda a estrutura lida — prova que a chave é LIDA",
    (caminho) => {
      const completo = lerAutorizacaoPedido(JSON.parse(AUTORIZACAO_PEDIDO_SERIALIZADO));
      const mutilado = lerAutorizacaoPedido(semChave(AUTORIZACAO_PEDIDO_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );
});

describe("paridade: captacao.autorizacao.listar (lado max-agent)", () => {
  it("lê os dois itens (proprietario com documento mascarado, imovel com endereço curto) exatamente como o ImobPro emite", () => {
    const { items, total } = lerFilaDeAutorizacoes(JSON.parse(AUTORIZACOES_LISTA_SERIALIZADO));
    expect(total).toBe(2);
    expect(items).toEqual([
      {
        ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza",
        documento: "***.456.789-**", criadoEm: "2026-10-19T12:00:00.000Z", justificativa: "Cliente pediu para eu atender",
      },
      {
        ref: 2, id: "aut-2", tipo: "imovel", codigo: "CAP-2026-0008", solicitante: "Bruno Lima",
        imovel: "Rua Augusta, 1250", criadoEm: "2026-10-19T13:30:00.000Z",
      },
    ]);
  });

  it("lista vazia diz 'Nenhum pedido aguardando você.'", () => {
    expect(textoDaFilaDeAutorizacoes({ items: [], total: 0 })).toBe("Nenhum pedido aguardando você.");
  });

  it("item sem `ref` válido (inteiro ≥ 1) é DESCARTADO — nunca vira 0 (achado de review 19/10)", () => {
    const base = { id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", criadoEm: "2026-10-19T12:00:00.000Z" };
    expect(lerItemDaFilaDeAutorizacao({ ...base })).toBeNull(); // sem `ref`
    expect(lerItemDaFilaDeAutorizacao({ ...base, ref: 0 })).toBeNull(); // 0 não é um número de item válido
    expect(lerItemDaFilaDeAutorizacao({ ...base, ref: -1 })).toBeNull();
    expect(lerItemDaFilaDeAutorizacao({ ...base, ref: 1.5 })).toBeNull();
    expect(lerItemDaFilaDeAutorizacao({ ...base, ref: "1" })).toBeNull();
    expect(lerItemDaFilaDeAutorizacao({ ...base, ref: 1 })?.ref).toBe(1);
  });

  it("na lista inteira, um item sem `ref` válido é removido (não aparece como ref:0)", () => {
    const { items, total } = lerFilaDeAutorizacoes({
      items: [
        { id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", criadoEm: "2026-10-19T12:00:00.000Z" },
        { ref: 2, id: "aut-2", tipo: "imovel", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", criadoEm: "2026-10-19T13:30:00.000Z" },
      ],
      total: 2,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.ref).toBe(2);
    expect(items.some((i) => i.ref === 0)).toBe(false);
    expect(total).toBe(2); // `total` é o que o servidor mandou, não recontado
  });

  it("o texto da fila nunca traz CPF/CNPJ inteiro nem nome do corretor dono da carteira (ausentes do vetor)", () => {
    const texto = textoDaFilaDeAutorizacoes(JSON.parse(AUTORIZACOES_LISTA_SERIALIZADO));
    expect(texto).toContain("Ana Souza");
    expect(texto).toContain("***.456.789-**");
    expect(texto).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    expect(texto).not.toContain("Carlos Dono");
    expect(texto).not.toContain("Maria Silva");
  });

  // ── segunda camada de máscara do documento (achado defensivo) ──────────
  it("documento JÁ mascarado pelo servidor passa intacto, byte a byte — o vetor de paridade não muda", () => {
    const { items } = lerFilaDeAutorizacoes(JSON.parse(AUTORIZACOES_LISTA_SERIALIZADO));
    expect(items[0]!.documento).toBe("***.456.789-**");
  });

  it("documento com 11 dígitos em claro (CPF sem máscara) é mascarado NESTE lado antes de guardar", () => {
    const base = { ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", criadoEm: "2026-10-19T12:00:00.000Z" };
    const item = lerItemDaFilaDeAutorizacao({ ...base, documento: "123.456.789-09" });
    expect(item?.documento).toBe("***.456.789-**");
    expect(item?.documento).not.toContain("123");
    expect(item?.documento).not.toContain("09");
  });

  it("documento com 14 dígitos em claro (CNPJ sem máscara) mostra só os dígitos do meio", () => {
    const base = { ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", criadoEm: "2026-10-19T12:00:00.000Z" };
    const item = lerItemDaFilaDeAutorizacao({ ...base, documento: "12.345.678/0001-95" });
    expect(item?.documento).toMatch(/^\*\*\.\d{3}\.\d{3}\/\d{4}-\*\*$/);
    expect(item?.documento).not.toMatch(/^12/);
    expect(item?.documento).not.toContain("95");
  });

  // ── a justificativa (texto livre de OUTRO corretor) nunca aparece com PII na fala do gerente ──
  it("justificativa com CPF nunca aparece inteiro na fala ao gerente (redigida antes de exibir)", () => {
    const base = { ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**", criadoEm: "2026-10-19T12:00:00.000Z" };
    const item = lerItemDaFilaDeAutorizacao({ ...base, justificativa: "Já atendi esse cliente, CPF 111.444.777-35, antes" })!;
    const texto = textoDoItemDaFila(item);
    expect(texto).not.toContain("111.444.777-35");
    expect(texto).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    expect(texto).toContain("Ana Souza"); // o resto da linha segue normal
  });

  it.each(
    // Exceto `total`: removê-lo cai no fallback `items.length`, que já vale 2 neste vetor — não
    // provaria menos sobre a leitura, só coincide com o valor-padrão (mesma ressalva do preflight).
    caminhos(JSON.parse(AUTORIZACOES_LISTA_SERIALIZADO)).map((c) => c.join(".")).filter((c) => c !== "total").map((c) => [c] as const)
  )(
    "remover `%s` muda a estrutura lida — prova que a chave é LIDA",
    (caminho) => {
      const completo = lerFilaDeAutorizacoes(JSON.parse(AUTORIZACOES_LISTA_SERIALIZADO));
      const mutilado = lerFilaDeAutorizacoes(semChave(AUTORIZACOES_LISTA_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );
});

describe("paridade: captacao.autorizacao.decidir (lado max-agent)", () => {
  it("lê id e status exatamente como o ImobPro emite", () => {
    expect(lerAutorizacaoDecisao(JSON.parse(AUTORIZACAO_DECISAO_SERIALIZADO))).toEqual({ id: "aut-1", status: "aprovada" });
  });

  it("sem autorizacao.id/status não é lido (fail-closed)", () => {
    expect(lerAutorizacaoDecisao({})).toBeNull();
  });

  it.each(caminhos(JSON.parse(AUTORIZACAO_DECISAO_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda a estrutura lida — prova que a chave é LIDA",
    (caminho) => {
      const completo = lerAutorizacaoDecisao(JSON.parse(AUTORIZACAO_DECISAO_SERIALIZADO));
      const mutilado = lerAutorizacaoDecisao(semChave(AUTORIZACAO_DECISAO_SERIALIZADO, caminho.split(".")));
      expect(mutilado, caminho).not.toEqual(completo);
    }
  );
});

describe("paridade: códigos da autorização (lado max-agent)", () => {
  it("a lista de códigos é a literal do ImobPro, na mesma ordem", () => {
    expect([...CODIGOS_DA_AUTORIZACAO]).toEqual(CODIGOS_DA_AUTORIZACAO_LITERAL);
  });

  it("o mapa de texto cobre exatamente esses códigos, na mesma ordem", () => {
    expect(Object.keys(TEXTO_POR_CODIGO_AUTORIZACAO)).toEqual(CODIGOS_DA_AUTORIZACAO_LITERAL);
  });

  it("todo código tem texto próprio em português, sem 'undefined' e sem PII (o parser do max-agent lê cada um)", () => {
    const link = "https://imobpro.ia.br/imoveis/captacoes/cap-1";
    const textos = CODIGOS_DA_AUTORIZACAO_LITERAL.map((c) => textoDoCodigoDeAutorizacao(c, { link }));
    for (const t of textos) {
      expect(t.length).toBeGreaterThan(5);
      expect(t).not.toContain("undefined");
      expect(t).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
    }
  });

  it("código desconhecido vira texto neutro mais o link, nunca o que o servidor escreveu", () => {
    const link = "https://imobpro.ia.br/imoveis/captacoes/cap-1";
    const t = textoDoCodigoDeAutorizacao("codigo_do_futuro", { link });
    expect(t).toContain(link);
    expect(t).not.toContain("codigo_do_futuro");
  });
});
