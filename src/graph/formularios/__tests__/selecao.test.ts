import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fluxo, RespostaDoServidor } from "../../fluxos";
import { novoFluxoV2 } from "../estado";
import type { OptionsV1, OptionsV2 } from "../contrato";
import {
  escolherVersao,
  ehFluxoDesligado,
  rebaixarCaptacaoParaV1,
  rebaixarParaV1,
  rebaixarSeFluxoDesligado,
  versaoDoFluxo,
} from "../selecao";
import { RE_CNPJ, RE_CPF } from "@/lib/pii";

const ORG = "org-piloto";
const agora = 1_000_000;

const optionsV1: OptionsV1 = { metodos: [], signatarios: [], assinaturaConfigurada: true, fluxoV2: false };
const optionsV2: OptionsV2 = {
  metodos: [], signatarios: [], assinaturaConfigurada: true,
  modalidades: [], obrigatorios: [], tiposDeAssinatura: [], fluxoV2: true,
};

function ligarLocal(ligado: boolean) {
  vi.stubEnv("MAX_FORMULARIOS_V2", ligado ? "true" : "false");
  vi.stubEnv("MAX_ROLLOUT_ORGS", ligado ? JSON.stringify({ [ORG]: ["formularios_v2"] }) : "{}");
}

afterEach(() => vi.unstubAllEnvs());

describe("escolherVersao (D3)", () => {
  it("v2 só com feature local E options.fluxoV2 (4 combinações)", () => {
    const casos: Array<[boolean, OptionsV1 | OptionsV2, 1 | 2]> = [
      [false, optionsV1, 1],
      [false, optionsV2, 1],
      [true, optionsV1, 1],
      [true, optionsV2, 2],
    ];
    for (const [local, options, esperado] of casos) {
      ligarLocal(local);
      expect(escolherVersao({ orgId: ORG, options }), `local=${local} fluxoV2=${options.fluxoV2}`).toBe(esperado);
    }
  });

  it("servidor antigo (sem a chave fluxoV2) é v1", () => {
    ligarLocal(true);
    const { fluxoV2: _omitido, ...semChave } = optionsV1;
    expect(escolherVersao({ orgId: ORG, options: semChave })).toBe(1);
  });

  it("outra org não herda a feature", () => {
    ligarLocal(true);
    expect(escolherVersao({ orgId: "outra-org", options: optionsV2 })).toBe(1);
  });

  it("fluxo v1 aberto continua v1 quando a org vira", () => {
    ligarLocal(true);
    const v1Proposta: Fluxo = { kind: "proposta", etapa: "coleta", dados: {}, atualizadoEm: agora };
    const v1Captacao = { kind: "captacao", etapa: "imovel", atualizadoEm: agora } as unknown as Fluxo;
    expect(versaoDoFluxo(v1Proposta)).toBe(1);
    expect(versaoDoFluxo(v1Captacao)).toBe(1);
    expect(escolherVersao({ orgId: ORG, options: optionsV2, fluxoAberto: v1Proposta })).toBe(1);
    expect(escolherVersao({ orgId: ORG, options: optionsV2, fluxoAberto: v1Captacao })).toBe(1);
  });

  it("fluxo v2 aberto continua v2 enquanto a feature e o servidor seguem ligados", () => {
    ligarLocal(true);
    const v2 = novoFluxoV2({ esteira: "venda", agora });
    expect(versaoDoFluxo(v2)).toBe(2);
    expect(escolherVersao({ orgId: ORG, options: optionsV2, fluxoAberto: v2 })).toBe(2);
  });

  it("desligar a feature no meio da conversa rebaixa o turno seguinte para v1", () => {
    ligarLocal(false);
    const v2 = novoFluxoV2({ esteira: "venda", agora });
    expect(escolherVersao({ orgId: ORG, options: optionsV2, fluxoAberto: v2 })).toBe(1);
    ligarLocal(true);
    expect(escolherVersao({ orgId: ORG, options: optionsV1, fluxoAberto: v2 })).toBe(1);
  });

  it("captação v2 marcada no estado também é lida como v2", () => {
    const cap = { kind: "captacao", etapa: "imovel", versao: 2, atualizadoEm: agora } as unknown as Fluxo;
    expect(versaoDoFluxo(cap)).toBe(2);
    expect(versaoDoFluxo(null)).toBeNull();
    expect(versaoDoFluxo({ kind: "credito" } as unknown as Fluxo)).toBeNull();
  });
});

describe("403 fluxo_desligado (D3)", () => {
  const desligado: RespostaDoServidor = { status: 403, body: { error: "fluxo_desligado" } };

  it("só o 403 com error=fluxo_desligado é o gate; outros 403 e 200 não", () => {
    expect(ehFluxoDesligado(desligado)).toBe(true);
    expect(ehFluxoDesligado({ status: 403, body: { error: "Forbidden", reason: "politica_nao_concede" } })).toBe(false);
    expect(ehFluxoDesligado({ status: 200, body: { error: "fluxo_desligado" } })).toBe(false);
    expect(ehFluxoDesligado(null)).toBe(false);
  });

  it("rebaixa para v1 preservando o extraído, sem rascunho ainda", () => {
    const f = { ...novoFluxoV2({ esteira: "locacao", agora }), etapa: "compor" as const };
    const extraido = { proponente: { nome: "Maria Teste" }, valor: 3200 };
    const v1 = rebaixarSeFluxoDesligado(f, desligado, extraido);
    expect(v1).toMatchObject({
      kind: "proposta", etapa: "coleta", natureza: "locacao", dados: extraido, atualizadoEm: agora,
    });
    expect(v1?.propostaId).toBeUndefined();
  });

  it("com rascunho já criado, o v1 retoma o rascunho em ajustes (o v1 pede o resto)", () => {
    const f = { ...novoFluxoV2({ esteira: "venda", agora }), proposalId: "prop-1", etapa: "revisar" as const };
    const v1 = rebaixarParaV1(f, { valor: 500000 });
    expect(v1).toMatchObject({ kind: "proposta", etapa: "ajustes", propostaId: "prop-1", natureza: "venda", ajustePendente: true });
    expect(v1.dados).toEqual({ valor: 500000 });
  });

  it("resposta que não é o gate não rebaixa", () => {
    const f = novoFluxoV2({ esteira: "venda", agora });
    expect(rebaixarSeFluxoDesligado(f, { status: 200, body: {} }, {})).toBeNull();
    expect(rebaixarSeFluxoDesligado(f, null, {})).toBeNull();
  });

  it("a captação v2 rebaixada vira v1 mantendo o resto do estado", () => {
    const cap = { kind: "captacao", etapa: "imovel", versao: 2, nome: "Casa teste", atualizadoEm: agora } as never;
    const v1 = rebaixarCaptacaoParaV1(cap);
    expect(versaoDoFluxo(v1 as unknown as Fluxo)).toBe(1);
    expect(v1).toMatchObject({ kind: "captacao", etapa: "imovel", nome: "Casa teste" });
  });
});

describe("checkpoint do v2 (PII)", () => {
  it("não contém CPF, e-mail nem telefone, nem com leitura de mídia pendente", () => {
    const f = {
      ...novoFluxoV2({ esteira: "venda", agora, schemaType: "compra_venda_v1" }),
      proposalId: "prop-1",
      aguardaCampo: { parteRef: "proponente:1", path: "compradores[0].cpf" },
      lidosPendentes: [{ path: "compradores[0].cpf", ref: "meta:wamid.ABC123" }],
      perguntados: ["compradores[0].cpf"],
    };
    const bruto = JSON.stringify(f);
    expect(bruto.match(RE_CPF)).toBeNull();
    expect(bruto.match(RE_CNPJ)).toBeNull();
    expect(bruto).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(bruto).not.toMatch(/\+?55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}/);
    expect(bruto).not.toContain("52998224725");
    expect(Object.keys(f)).not.toContain("dados");
  });
});
