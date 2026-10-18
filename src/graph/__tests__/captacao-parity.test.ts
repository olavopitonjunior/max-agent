import { describe, it, expect } from "vitest";
import {
  CODIGOS_DO_ENVIO,
  TEXTO_POR_CODIGO,
  lerItemDaCaptacao,
  lerPreflight,
  textoDaLista,
  textoDoCodigoDeEnvio,
  textoDoItemDaCaptacao,
  textoDoPreflight,
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
 */

const ITEM_COM_DONOS_SERIALIZADO =
  '{"ref":1,"id":"cap-1","codigo":"CAP-2026-0007","nome":"Apto da Dona Maria","esteira":"venda",' +
  '"estado":"Vence em 12 dias","tom":"warning","endereco":"Rua Augusta, 1250 — ap 42",' +
  '"atualizadoEm":"2026-10-16T13:00:00.000Z","link":"/imoveis/captacoes/cap-1","proprietarios":["Maria Silva"]}';
const ITEM_SEM_DONOS_SERIALIZADO =
  '{"ref":1,"id":"cap-1","codigo":"CAP-2026-0007","nome":"Apto da Dona Maria","esteira":"venda",' +
  '"estado":"Vence em 12 dias","tom":"warning","endereco":"Rua Augusta, 1250 — ap 42",' +
  '"atualizadoEm":"2026-10-16T13:00:00.000Z","link":"/imoveis/captacoes/cap-1"}';
const PREFLIGHT_SERIALIZADO =
  '{"pronto":false,"faltantes":[{"path":"imovel.matricula","rotulo":"Matrícula","etapa":"imovel"},' +
  '{"path":"proprietarios[].cpf","rotulo":"CPF","etapa":"proprietarios","proprietarioId":"p1"}],' +
  '"bloqueios":[{"codigo":"soma_percentuais"}],"emBranco":1}';
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
    for (const vetor of [ITEM_COM_DONOS_SERIALIZADO, ITEM_SEM_DONOS_SERIALIZADO, PREFLIGHT_SERIALIZADO]) {
      const chaves = chavesProfundas(JSON.parse(vetor));
      for (const proibida of CHAVES_PROIBIDAS_AO_MAX) {
        expect(chaves, proibida).not.toContain(proibida);
        expect(vetor).not.toContain(`"${proibida}"`);
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

describe("paridade: preflight (lado max-agent)", () => {
  it("parseia o vetor e o texto liga o proprietário ao nome do fluxo", () => {
    const raw = JSON.parse(PREFLIGHT_SERIALIZADO);
    expect(lerPreflight(raw)).toEqual({
      pronto: false,
      faltantes: [
        { path: "imovel.matricula", rotulo: "Matrícula", etapa: "imovel" },
        { path: "proprietarios[].cpf", rotulo: "CPF", etapa: "proprietarios", proprietarioId: "p1" },
      ],
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

  it("o preflight nunca traz valor nem nome: o texto só usa o nome que o FLUXO guardou", () => {
    const texto = textoDoPreflight(JSON.parse(PREFLIGHT_SERIALIZADO), {});
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

  it.each(caminhos(JSON.parse(PREFLIGHT_SERIALIZADO)).map((c) => [c.join(".")] as const))(
    "remover `%s` muda o texto — prova que a chave é LIDA",
    (caminho) => {
      const completo = textoDoPreflight(JSON.parse(PREFLIGHT_SERIALIZADO), NOMES);
      const mutilado = textoDoPreflight(semChave(PREFLIGHT_SERIALIZADO, caminho.split(".")), NOMES);
      expect(mutilado).not.toBe(completo);
    }
  );
});
