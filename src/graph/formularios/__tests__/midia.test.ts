import { describe, expect, it, vi } from "vitest";
import {
  fraseDeNaoLido,
  lerMidia,
  TETO_DA_MIDIA_BYTES,
  type DepsDaMidia,
  type LeituraDeDocumento,
  type MidiaRecebida,
} from "../midia";

/**
 * T7 — a entrada ÚNICA da mídia recebida (Max e Newton).
 *
 * `lerMidia` não toca rede por conta própria: baixar, transcrever e ler o
 * documento chegam por `deps`. Os testes afirmam o que importa para o
 * corretor (a frase certa por motivo) e para o custo (o servidor NÃO é chamado
 * quando a mídia nem deveria ir).
 */

// A chave do cofre dos lidos: sem ela `lerMidia` nem paga o OCR (Rodada 1, M4).
process.env.MAX_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000, 2)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(2000, 3)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(2000, 4)]);

const LEITURA_OK: LeituraDeDocumento = {
  ok: true,
  documentType: "rg",
  confianca: 0.9,
  campos: [{ path: "compradores[0].nome", valor: "Maria Teste", confianca: 0.9 }],
  ignorados: 1,
};

const ctx = { orgId: "org1", messageId: "wamid.FOTO1" };

function deps(over: Partial<DepsDaMidia> = {}): DepsDaMidia & {
  baixar: ReturnType<typeof vi.fn>;
  lerDocumento: ReturnType<typeof vi.fn>;
  transcrever: ReturnType<typeof vi.fn>;
} {
  return {
    baixar: vi.fn().mockResolvedValue({ data: JPEG, contentType: "image/jpeg" }),
    lerDocumento: vi.fn().mockResolvedValue(LEITURA_OK),
    transcrever: vi.fn().mockResolvedValue("texto do áudio"),
    temDocumentRead: true,
    newtonMidiaAtiva: () => true,
    ...over,
  } as never;
}

const foto = (extra: Partial<MidiaRecebida> = {}): MidiaRecebida => ({
  kind: "image",
  ref: "meta:123",
  mimeType: "image/jpeg",
  ...extra,
});

describe("lerMidia: leitura pelo servidor (T7)", () => {
  it("foto: baixa, manda ao servidor com a messageId como chave e devolve os campos", async () => {
    const d = deps();
    const r = await lerMidia(d, foto(), { ...ctx, schemaType: "venda_padrao", tipo: "venda" });

    expect(r).toEqual({
      tipo: "campos",
      documentType: "rg",
      confianca: 0.9,
      campos: LEITURA_OK.ok ? LEITURA_OK.campos : [],
      ignorados: 1,
    });
    expect(d.lerDocumento).toHaveBeenCalledTimes(1);
    const arg = d.lerDocumento.mock.calls[0]![0];
    expect(arg).toMatchObject({
      base64: JPEG.toString("base64"),
      mimeType: "image/jpeg",
      alvo: "proposta",
      schemaType: "venda_padrao",
      tipo: "venda",
      idempotencyKey: "wamid.FOTO1",
    });
  });

  it("PDF lido pelos bytes: o mime declarado não decide", async () => {
    const d = deps({ baixar: vi.fn().mockResolvedValue({ data: PDF, contentType: "application/octet-stream" }) });
    const r = await lerMidia(d, { kind: "document", ref: "meta:9", mimeType: "application/octet-stream" }, ctx);
    expect(r.tipo).toBe("campos");
    expect(d.lerDocumento.mock.calls[0]![0].mimeType).toBe("application/pdf");
  });

  it("> 3 MB responde 'arquivo grande demais' e não chama o servidor", async () => {
    const grande = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(TETO_DA_MIDIA_BYTES, 1)]);
    const d = deps({ baixar: vi.fn().mockResolvedValue({ data: grande, contentType: "image/jpeg" }) });

    const r = await lerMidia(d, foto(), ctx);

    expect(r).toEqual({ tipo: "nao_lido", motivo: "tamanho" });
    expect(d.lerDocumento).not.toHaveBeenCalled();
    expect(fraseDeNaoLido("tamanho", "image")).toMatch(/grande demais/i);
  });

  it("HEIC pelos bytes: frase honesta de formato, o servidor não é chamado", async () => {
    const d = deps({ baixar: vi.fn().mockResolvedValue({ data: HEIC, contentType: "image/heic" }) });
    const r = await lerMidia(d, foto({ mimeType: "image/heic" }), ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "heic" });
    expect(d.lerDocumento).not.toHaveBeenCalled();
    expect(fraseDeNaoLido("heic", "image")).toBe(
      "Não consigo ler foto nesse formato; mande como captura de tela ou digite."
    );
  });

  it("HEIC que passou pelo sniff e o servidor recusou (415 formato_heic_nao_suportado) vira a mesma frase", async () => {
    const d = deps({ lerDocumento: vi.fn().mockResolvedValue({ ok: false, motivo: "heic" }) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "heic" });
  });

  it("formato fora de jpeg/png/webp/pdf: 'mime', sem chamar o servidor", async () => {
    const d = deps({ baixar: vi.fn().mockResolvedValue({ data: GIF, contentType: "image/gif" }) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "mime" });
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("PDF sem document.read responde a frase honesta nova e nem baixa o arquivo", async () => {
    const d = deps({ temDocumentRead: false });
    const r = await lerMidia(d, { kind: "document", ref: "meta:9", mimeType: "application/pdf" }, ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
    expect(d.baixar).not.toHaveBeenCalled();
    expect(d.lerDocumento).not.toHaveBeenCalled();
    expect(fraseDeNaoLido("sem_leitura", "document")).toBe(
      "Ainda não leio PDF aqui; mande foto ou digite."
    );
  });

  it("documento ilegível e falha do servidor viram motivos distintos", async () => {
    const ilegivel = deps({ lerDocumento: vi.fn().mockResolvedValue({ ok: false, motivo: "ilegivel" }) });
    expect(await lerMidia(ilegivel, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "ilegivel" });
    const falha = deps({ lerDocumento: vi.fn().mockResolvedValue({ ok: false, motivo: "falha" }) });
    expect(await lerMidia(falha, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "falha" });
  });

  it("502 leitura_indisponivel: repete UMA vez com chave NOVA; a mesma chave seguiria devolvendo 502", async () => {
    const lerDocumento = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, motivo: "indisponivel" })
      .mockResolvedValueOnce(LEITURA_OK);
    const d = deps({ lerDocumento });
    const r = await lerMidia(d, foto(), ctx);
    expect(r.tipo).toBe("campos");
    const chaves = lerDocumento.mock.calls.map((c) => c[0].idempotencyKey);
    expect(chaves[0]).toBe("wamid.FOTO1");
    expect(chaves[1]).not.toBe(chaves[0]);
  });

  it("prazo estourado (processando): NÃO repete (nova chave = segundo OCR pago) e a frase não manda 'tentar de novo'", async () => {
    const lerDocumento = vi.fn().mockResolvedValue({ ok: false, motivo: "processando" });
    const d = deps({ lerDocumento });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "processando" });
    expect(lerDocumento).toHaveBeenCalledTimes(1);
    const frase = fraseDeNaoLido("processando", "image");
    expect(frase).toMatch(/ainda estou lendo/i);
    expect(frase).not.toMatch(/tente de novo|tentar de novo/i);
  });

  it("o adaptador recusou por tamanho ({erro:'tamanho'}): motivo 'tamanho', o servidor não é chamado (I3)", async () => {
    const d = deps({ baixar: vi.fn().mockResolvedValue({ erro: "tamanho" }) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "tamanho" });
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("pede ao download que distinga o tamanho (senão o adaptador devolve null e vira 'falha')", async () => {
    const d = deps();
    await lerMidia(d, foto(), ctx);
    expect(d.baixar).toHaveBeenCalledWith("meta:123", { distinguirTamanho: true });
  });

  it("sem a chave do cofre (M4/N4) nem baixa nem paga o OCR: 'sem_cofre', o servidor não é chamado", async () => {
    const antiga = process.env.MAX_ENCRYPTION_KEY;
    process.env.MAX_ENCRYPTION_KEY = "";
    try {
      const d = deps();
      expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "sem_cofre" });
      expect(d.baixar).not.toHaveBeenCalled();
      expect(d.lerDocumento).not.toHaveBeenCalled();
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antiga;
    }
  });

  it("chave do cofre com tamanho errado também é recusada antes do OCR", async () => {
    const antiga = process.env.MAX_ENCRYPTION_KEY;
    process.env.MAX_ENCRYPTION_KEY = Buffer.alloc(8, 1).toString("base64");
    try {
      const d = deps();
      expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "sem_cofre" });
      expect(d.lerDocumento).not.toHaveBeenCalled();
    } finally {
      process.env.MAX_ENCRYPTION_KEY = antiga;
    }
  });

  it("N4: a frase de 'sem_cofre' não manda tentar de novo e oferece digitar", () => {
    const f = fraseDeNaoLido("sem_cofre", "image");
    expect(f).not.toMatch(/de novo|novamente|reenvie|mande outra/i);
    expect(f).toMatch(/digit/i);
  });

  it("M3: 403 fluxo_desligado do servidor vira o motivo próprio, e a frase não cita código interno", async () => {
    const d = deps({ lerDocumento: vi.fn().mockResolvedValue({ ok: false, motivo: "fluxo_desligado" }) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "fluxo_desligado" });
    expect(fraseDeNaoLido("fluxo_desligado", "image")).not.toMatch(/fluxo_desligado|403/);
  });

  it("nunca lança: erro inesperado do download vira 'falha'", async () => {
    const d = deps({ baixar: vi.fn().mockRejectedValue(new Error("https://zapi.example/segredo/rg.jpg caiu")) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "falha" });
  });

  it("download que não veio (null) é 'falha'", async () => {
    const d = deps({ baixar: vi.fn().mockResolvedValue(null) });
    expect(await lerMidia(d, foto(), ctx)).toEqual({ tipo: "nao_lido", motivo: "falha" });
  });
});

describe("lerMidia: Newton (zapi:<url>) só com NEWTON_MEDIA_INBOUND", () => {
  it("flag desligada: não baixa, não chama o servidor e diz 'não leio' (M6), não 'tente de novo'", async () => {
    const d = deps({ newtonMidiaAtiva: () => false });
    const r = await lerMidia(d, foto({ ref: "zapi:https://media.zapi.example/x/rg.jpeg" }), ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "sem_leitura" });
    expect(d.baixar).not.toHaveBeenCalled();
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("flag ligada: baixa e lê como a da Meta", async () => {
    const d = deps({ newtonMidiaAtiva: () => true });
    const r = await lerMidia(d, foto({ ref: "zapi:https://media.zapi.example/x/rg.jpeg" }), ctx);
    expect(r.tipo).toBe("campos");
    expect(d.baixar).toHaveBeenCalledWith("zapi:https://media.zapi.example/x/rg.jpeg", { distinguirTamanho: true });
  });

  it("a URL da Z-API nunca aparece em log nem em erro", async () => {
    const url = "https://media.zapi.example/instances/X/segredo-do-cliente/rg.jpeg";
    const logs: string[] = [];
    const espioes = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")))
    );
    try {
      const d = deps({ baixar: vi.fn().mockRejectedValue(new Error(`falhou em ${url}`)) });
      const r = await lerMidia(d, foto({ ref: `zapi:${url}` }), ctx);
      expect(JSON.stringify(r)).not.toContain("segredo-do-cliente");
      expect(logs.join("\n")).not.toContain("segredo-do-cliente");
    } finally {
      espioes.forEach((e) => e.mockRestore());
    }
  });
});

describe("lerMidia: áudio", () => {
  it("áudio vira texto pela transcrição, sem document.read", async () => {
    const d = deps({
      temDocumentRead: false,
      baixar: vi.fn().mockResolvedValue({ data: Buffer.from("OggS...."), contentType: "audio/ogg" }),
    });
    const r = await lerMidia(d, { kind: "audio", ref: "meta:7", mimeType: "audio/ogg" }, ctx);
    expect(r).toEqual({ tipo: "texto", texto: "texto do áudio" });
    expect(d.lerDocumento).not.toHaveBeenCalled();
  });

  it("transcrição que falha é 'falha'", async () => {
    const d = deps({ transcrever: vi.fn().mockResolvedValue(null) });
    const r = await lerMidia(d, { kind: "audio", ref: "meta:7", mimeType: "audio/ogg" }, ctx);
    expect(r).toEqual({ tipo: "nao_lido", motivo: "falha" });
  });
});

describe("fraseDeNaoLido", () => {
  it("cada motivo tem frase própria, sem código interno nem URL", () => {
    const motivos = ["mime", "heic", "tamanho", "ilegivel", "sem_leitura", "falha", "processando"] as const;
    const frases = motivos.map((m) => fraseDeNaoLido(m, "image"));
    expect(new Set(frases).size).toBe(motivos.length);
    for (const f of frases) expect(f).not.toMatch(/https?:|_|politica|formato_/i);
  });
});
