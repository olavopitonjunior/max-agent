import { afterEach, describe, expect, it, vi } from "vitest";
import { CPF_SINTETICO, HEIC, JPEG, ModeloFalso, PDF, PESSOAS, Sessao, formatarCpf, roteirosDe, verificarTransversais } from "./harness";
import { lerDocumento, transcribeMedia } from "@/lib/cm";

/**
 * Foto e PDF: com `document.read` na política, a leitura do documento é do servidor (`lerDocumento`) e volta
 * como campos com caminho; sem ela, o fallback de OCR (`transcribeMedia`) entra como `documento_lido`
 * cercado. O que veio de documento só vale depois do "sim", e a legenda diz DE QUEM é.
 */
const POLITICA = ["proposal.create", "proposal.send", "document.read"];

function leitura(documentType: string, campos: Array<[string, string]>) {
  return { ok: true, documentType, confianca: 0.9, campos: campos.map(([path, valor]) => ({ path, valor, confianca: 0.9 })), ignorados: 0 } as never;
}

describe("eval fv2: foto e documento", () => {
  let s: Sessao;
  afterEach(async () => {
    await verificarTransversais(s);
  });

  it("RG com legenda: ficha mascarada, grava só no sim e pergunta o que falta", async () => {
    s = new Sessao({ politica: POLITICA, modelo: new ModeloFalso(), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    vi.mocked(lerDocumento).mockResolvedValue(
      leitura("rg", [
        ["compradores[0].nome", PESSOAS.comprador],
        ["compradores[0].cpf", CPF_SINTETICO],
      ])
    );

    const t1 = await s.midia({ mimeType: "image/jpeg", bytes: JPEG, legenda: "RG do comprador" });
    expect(lerDocumento).toHaveBeenCalledTimes(1);
    expect(t1.reply).toContain(PESSOAS.comprador);
    expect(t1.reply).toContain("***.982.247-**");
    expect(t1.reply).not.toContain(CPF_SINTETICO);
    expect(t1.reply).toMatch(/responda SIM/i);
    expect(s.servidor.escritas()).toHaveLength(0);
    // O modelo de extração nunca viu o documento: o valor lido não passa por ele.
    expect(s.modelo.chamadas.every((c) => !c.conteudo.includes(CPF_SINTETICO))).toBe(true);

    const t2 = await s.fala("sim");
    expect(t2.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores[0]).toMatchObject({ nome: PESSOAS.comprador, cpf: CPF_SINTETICO });
    // Falta o valor: a próxima pergunta é a única, sem inventar.
    expect(t2.reply).toContain('"Valor da proposta"');
  });

  it("matrícula (PDF) com legenda: grava o que cabe, avisa o que ficou de fora", async () => {
    s = new Sessao({ politica: POLITICA, modelo: new ModeloFalso(), nomes: [PESSOAS.comprador], cpfs: [] });
    await s.preparar();
    await s.semear();
    vi.mocked(lerDocumento).mockResolvedValue(
      leitura("matricula", [
        ["imovel.matricula", "12345"],
        ["imovel.cartorio", "1º Registro de Imóveis de São Paulo"],
        ["imovel.endereco.logradouro", "Rua das Flores"],
      ])
    );

    const t1 = await s.midia({ kind: "document", mimeType: "application/pdf", bytes: PDF, legenda: "matrícula do imóvel" });
    expect(t1.reply).toContain("Matrícula: 12345");
    expect(t1.reply).toContain("Cartório");
    expect(t1.reply).toContain("não cabe na proposta, vou ignorar");
    expect(s.servidor.escritas()).toHaveLength(0);

    const t2 = await s.fala("sim");
    expect(t2.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.imovel).toMatchObject({ matricula: "12345", cartorio: "1º Registro de Imóveis de São Paulo" });
    expect(s.servidor.rascunho?.imovel).not.toHaveProperty("endereco.logradouro");
    expect(t2.reply).toContain("Um dado não cabe na proposta e ficou de fora.");
  });

  it("HEIC é recusado com orientação, sem leitura e sem escrita", async () => {
    s = new Sessao({ politica: POLITICA, modelo: new ModeloFalso(), nomes: [], cpfs: [] });
    await s.preparar();
    await s.semear();

    const t = await s.midia({ mimeType: "image/heic", bytes: HEIC, legenda: "RG do comprador" });
    expect(t.reply).toContain("Não consigo ler foto nesse formato; mande como captura de tela ou digite.");
    expect(lerDocumento).not.toHaveBeenCalled();
    expect(s.servidor.escritas()).toHaveLength(0);
  });

  it("sem legenda: confere o que leu mas não anota, e o sim não grava dado de dono desconhecido", async () => {
    s = new Sessao({ politica: POLITICA, modelo: new ModeloFalso(), nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    vi.mocked(lerDocumento).mockResolvedValue(
      leitura("rg", [
        ["compradores[0].nome", PESSOAS.comprador],
        ["compradores[0].cpf", CPF_SINTETICO],
      ])
    );

    const t1 = await s.midia({ mimeType: "image/jpeg", bytes: JPEG });
    expect(t1.reply).toContain("De quem é esse documento?");
    expect(t1.reply).toContain("Nada foi anotado ainda.");
    expect(s.servidor.escritas()).toHaveLength(0);

    const t2 = await s.fala("sim");
    expect(t2.escritas).toHaveLength(0);
    expect(t2.reply).toContain("não sei de quem são");
    expect(s.servidor.rascunho).toBeNull();
  });

  it("PDF sem a capability document.read: orienta a mandar foto ou digitar, sem ler", async () => {
    s = new Sessao({ politica: ["proposal.create", "proposal.send"], modelo: new ModeloFalso(), nomes: [], cpfs: [] });
    await s.preparar();
    await s.semear();

    const t = await s.midia({ kind: "document", mimeType: "application/pdf", bytes: PDF, legenda: "matrícula" });
    expect(t.reply).toContain("Ainda não leio PDF aqui; mande foto ou digite.");
    expect(lerDocumento).not.toHaveBeenCalled();
    expect(s.servidor.escritas()).toHaveLength(0);
  });

  it("arquivo grande demais é recusado", async () => {
    s = new Sessao({ politica: POLITICA, modelo: new ModeloFalso(), nomes: [], cpfs: [] });
    await s.preparar();
    await s.semear();

    const t = await s.midia({ mimeType: "image/jpeg", bytes: Buffer.concat([JPEG, Buffer.alloc(3_500_000, 1)]), legenda: "RG do comprador" });
    expect(t.reply).toMatch(/grande demais/i);
    expect(lerDocumento).not.toHaveBeenCalled();
    expect(s.servidor.escritas()).toHaveLength(0);
  });

  it("fallback de OCR (sem document.read): o texto lido entra cercado e tokenizado no modelo", async () => {
    const modelo = new ModeloFalso().roteiro(...roteirosDe([{ compradores: [{ nome: PESSOAS.comprador, cpf: "{{CPF:1}}" }] }]));
    s = new Sessao({ politica: ["proposal.create", "proposal.send"], fallbackOcr: true, modelo, nomes: [PESSOAS.comprador], cpfs: [CPF_SINTETICO] });
    await s.preparar();
    await s.semear();
    vi.mocked(transcribeMedia).mockResolvedValue(`Nome: ${PESSOAS.comprador}\nCPF ${formatarCpf(CPF_SINTETICO)}`);

    const t1 = await s.midia({ mimeType: "image/jpeg", bytes: JPEG, legenda: "RG do comprador" });
    expect(lerDocumento).not.toHaveBeenCalled();
    expect(transcribeMedia).toHaveBeenCalled();
    expect(s.modelo.chamadas[0]!.conteudo).toContain("<documento_lido");
    expect(s.modelo.chamadas[0]!.conteudo).toContain("⟨CPF_1⟩");
    // Falta o valor: o turno fica em silêncio e a ficha (mascarada) sai agendada pelo outbox.
    expect(t1.reply).toBeNull();
    expect(s.fichasAgendadas[0]).toContain("***.982.247-**");
    expect(s.fichasAgendadas[0]).not.toContain(formatarCpf(CPF_SINTETICO));
    expect(s.servidor.escritas()).toHaveLength(0);

    s.fichaAgendadaFoiEnviada();
    const t2 = await s.fala("sim");
    expect(t2.escritas.map((w) => [w.verb, w.status])).toEqual([["proposal.create", 201]]);
    expect(s.servidor.rascunho?.compradores[0]).toMatchObject({ nome: PESSOAS.comprador, cpf: CPF_SINTETICO });
  });

  it("fallback de OCR que não consegue ler: pede para digitar, sem escrita", async () => {
    s = new Sessao({ politica: ["proposal.create", "proposal.send"], fallbackOcr: true, modelo: new ModeloFalso(), nomes: [], cpfs: [] });
    await s.preparar();
    await s.semear();
    vi.mocked(transcribeMedia).mockResolvedValue(null);

    const t = await s.midia({ mimeType: "image/jpeg", bytes: JPEG, legenda: "RG do comprador" });
    expect(t.reply).toBeTruthy();
    expect(s.servidor.escritas()).toHaveLength(0);
    expect(s.servidor.rascunho).toBeNull();
  });
});
