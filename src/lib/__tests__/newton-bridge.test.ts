import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newtonBridgeAdapter } from "../transport/adapters/newton-bridge";
import { idDoBridge, idSintetico, textoDoBridge } from "../transport/newton-inbound";

/**
 * Contrato com o `whatsapp-newton-bridge` (`src/app/api/send/route.ts`):
 * `POST /api/send`, `Bearer BRIDGE_INTERNAL_TOKEN`, `{to, body, context?}`,
 * resposta `{provider, messageId, raw}`.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEWTON_BRIDGE_URL", "https://bridge.example/");
  vi.stubEnv("NEWTON_BRIDGE_TOKEN", "tok-teste");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

function ok(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

describe("newtonBridgeAdapter.sendText", () => {
  it("posta no /api/send com Bearer e devolve o messageId do bridge", async () => {
    fetchMock.mockResolvedValue(ok({ provider: "zapi", messageId: "ZAPI-1", raw: {} }));
    const r = await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "oi" });
    expect(r).toEqual({ messageId: "ZAPI-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example/api/send");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-teste");
    expect(JSON.parse(init.body)).toEqual({ to: "5511900000001", body: "oi" });
  });

  it("corta o corpo em 4096", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "x".repeat(5000) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).toHaveLength(4096);
  });

  it("cita id real da Z-API, nunca o sintético da rota", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a", quoteMessageId: "3EB0ABC" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).context).toEqual({ message_id: "3EB0ABC" });
    await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "b", quoteMessageId: "newton:abc" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).context).toBeUndefined();
  });

  it("aceita grupo no formato do bridge e recusa destino fora dele sem rede", async () => {
    fetchMock.mockResolvedValue(ok({ messageId: "Z" }));
    await newtonBridgeAdapter.sendText({ to: "120363012345678901-group", body: "a" });
    await expect(newtonBridgeAdapter.sendText({ to: "+55 11 9999", body: "a" })).rejects.toThrow(
      "newton_bridge_destino_invalido"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("erro HTTP do bridge vira newton_bridge_http_<status>, sem ecoar o corpo", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "segredo-da-zapi" }), { status: 500 }));
    const err = await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" }).catch((e) => e);
    expect(err.message).toBe("newton_bridge_http_500");
  });

  it("sem URL ou token lança antes de qualquer rede", async () => {
    vi.stubEnv("NEWTON_BRIDGE_TOKEN", "");
    await expect(newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" })).rejects.toThrow(
      "newton_bridge_nao_configurado"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("messageId ausente na resposta vira null", async () => {
    fetchMock.mockResolvedValue(ok({ provider: "zapi" }));
    expect(await newtonBridgeAdapter.sendText({ to: "5511900000001", body: "a" })).toEqual({ messageId: null });
  });
});

describe("newtonBridgeAdapter: capacidades", () => {
  it("texto livre sempre: sem template, sem janela, sem mídia, sem status", () => {
    expect(newtonBridgeAdapter.capabilities).toEqual({
      templates: false,
      window24h: false,
      media: false,
      groups: true,
      status: false,
      typing: false,
      interactive: false,
      reactions: false,
    });
    expect(newtonBridgeAdapter.sendTemplate).toBeUndefined();
    expect(newtonBridgeAdapter.markReadTyping).toBeUndefined();
  });

  it("connectionStatus falha aberto e downloadMedia não baixa nada", async () => {
    expect((await newtonBridgeAdapter.connectionStatus()).connected).toBe(true);
    expect(await newtonBridgeAdapter.downloadMedia("x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("newtonBridgeAdapter.downloadMedia", () => {
  const URL_OK = "https://media.zapi.example/instances/X/segredo-do-cliente/foto.jpeg";
  const REF = `zapi:${URL_OK}`;
  const MB3 = 3 * 1024 * 1024;
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

  beforeEach(() => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "media.zapi.example");
  });

  function resposta(corpo: Buffer, init: ResponseInit = {}) {
    return new Response(new Uint8Array(corpo), { status: 200, ...init });
  }

  it("ref que não é zapi: nem chega à rede", async () => {
    expect(await newtonBridgeAdapter.downloadMedia("meta:123")).toBeNull();
    expect(await newtonBridgeAdapter.downloadMedia(URL_OK)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("host fora da allowlist, http, IP interno e host com @ não são baixados", async () => {
    const proibidas = [
      "zapi:https://evil.example/a.jpg",
      "zapi:http://media.zapi.example/a.jpg",
      "zapi:https://127.0.0.1/a.jpg",
      "zapi:https://localhost/a.jpg",
      "zapi:https://media.zapi.example@evil.example/a.jpg",
    ];
    for (const ref of proibidas) expect(await newtonBridgeAdapter.downloadMedia(ref)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allowlist vazia recusa tudo, sem rede", async () => {
    vi.stubEnv("NEWTON_MEDIA_HOSTS", "");
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("os bytes mandam, não o cabeçalho: JPEG com octet-stream vira image/jpeg", async () => {
    fetchMock.mockResolvedValue(resposta(JPEG, { headers: { "content-type": "application/octet-stream" } }));
    const r = await newtonBridgeAdapter.downloadMedia(REF);
    expect(r?.contentType).toBe("image/jpeg");
    expect(r?.data.equals(JPEG)).toBe(true);
  });

  it("HTML com content-type application/pdf é recusado", async () => {
    fetchMock.mockResolvedValue(resposta(Buffer.from("<html><script>x</script></html>"), { headers: { "content-type": "application/pdf" } }));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
  });

  it("PDF de verdade vale application/pdf mesmo declarado como imagem", async () => {
    fetchMock.mockResolvedValue(resposta(Buffer.from("%PDF-1.7\n1 0 obj"), { headers: { "content-type": "image/jpeg" } }));
    expect((await newtonBridgeAdapter.downloadMedia(REF))?.contentType).toBe("application/pdf");
  });

  it("404, 410 e fetch que lança devolvem null", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nao", { status: 404 }));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("sumiu", { status: 410 }));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
  });

  it("Content-Length acima de 3 MB devolve null sem ler o corpo", async () => {
    const res = resposta(JPEG, { headers: { "content-length": String(MB3 + 1) } });
    const arrayBuffer = vi.spyOn(res, "arrayBuffer");
    const getReader = vi.spyOn(res.body as ReadableStream, "getReader");
    fetchMock.mockResolvedValue(res);
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
  });

  it("sem Content-Length: 3 MB + 1 byte devolve null; exatamente 3 MB devolve o buffer", async () => {
    const com = (n: number) => Buffer.concat([JPEG, Buffer.alloc(n - JPEG.length)]);
    fetchMock.mockResolvedValueOnce(resposta(com(MB3 + 1)));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    fetchMock.mockResolvedValueOnce(resposta(com(MB3)));
    const r = await newtonBridgeAdapter.downloadMedia(REF);
    expect(r?.data.byteLength).toBe(MB3);
  });

  it("corpo que passa do teto no meio do stream é cortado sem ler tudo", async () => {
    let lidos = 0;
    const corpo = new ReadableStream<Uint8Array>({
      pull(c) {
        lidos += 1;
        c.enqueue(new Uint8Array(1024 * 1024));
        if (lidos > 100) c.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(corpo, { status: 200 }));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    expect(lidos).toBeLessThan(10);
  });

  it("corpo vazio devolve null", async () => {
    fetchMock.mockResolvedValue(resposta(Buffer.alloc(0)));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
  });

  // Rodada 1, I3: o ADAPTADOR REAL diz que recusou por tamanho (o grafo responde "grande demais");
  // sem o pedido explícito segue `null`, como os chamadores antigos esperam.
  describe("distinguirTamanho (I3)", () => {
    const PEDIDO = { distinguirTamanho: true } as const;

    it("Content-Length acima de 3 MB vira { erro: 'tamanho' }, sem ler o corpo", async () => {
      const res = resposta(JPEG, { headers: { "content-length": String(MB3 + 1) } });
      const getReader = vi.spyOn(res.body as ReadableStream, "getReader");
      fetchMock.mockResolvedValue(res);
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toEqual({ erro: "tamanho" });
      expect(getReader).not.toHaveBeenCalled();
    });

    it("sem Content-Length, 3 MB + 1 byte vira { erro: 'tamanho' }; exatamente 3 MB devolve o buffer", async () => {
      const com = (n: number) => Buffer.concat([JPEG, Buffer.alloc(n - JPEG.length)]);
      fetchMock.mockResolvedValueOnce(resposta(com(MB3 + 1)));
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toEqual({ erro: "tamanho" });
      fetchMock.mockResolvedValueOnce(resposta(com(MB3)));
      const r = await newtonBridgeAdapter.downloadMedia(REF, PEDIDO);
      expect(r && "data" in r ? r.data.byteLength : -1).toBe(MB3);
    });

    it("corpo que estoura no meio do stream vira { erro: 'tamanho' }", async () => {
      let lidos = 0;
      const corpo = new ReadableStream<Uint8Array>({
        pull(c) {
          lidos += 1;
          c.enqueue(new Uint8Array(1024 * 1024));
          if (lidos > 100) c.close();
        },
      });
      fetchMock.mockResolvedValue(new Response(corpo, { status: 200 }));
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toEqual({ erro: "tamanho" });
    });

    it("sem o pedido, a mesma recusa continua null", async () => {
      fetchMock.mockResolvedValue(resposta(JPEG, { headers: { "content-length": String(MB3 + 1) } }));
      expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    });

    it("o que NÃO é tamanho segue null: corpo vazio, 404, host fora da allowlist, tipo desconhecido", async () => {
      fetchMock.mockResolvedValueOnce(resposta(Buffer.alloc(0)));
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toBeNull();
      fetchMock.mockResolvedValueOnce(new Response("nao", { status: 404 }));
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toBeNull();
      expect(await newtonBridgeAdapter.downloadMedia("zapi:https://evil.example/a.jpg", PEDIDO)).toBeNull();
      fetchMock.mockResolvedValueOnce(resposta(Buffer.from("<html>x</html>")));
      expect(await newtonBridgeAdapter.downloadMedia(REF, PEDIDO)).toBeNull();
    });

    it("o log da recusa por tamanho segue sem a URL (só host e motivo)", async () => {
      const espioes = (["warn", "error", "log", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      try {
        fetchMock.mockResolvedValue(resposta(JPEG, { headers: { "content-length": String(MB3 + 1) } }));
        await newtonBridgeAdapter.downloadMedia(REF, PEDIDO);
        const impresso = espioes.flatMap((e) => e.mock.calls).map((c) => c.map(String).join(" ")).join("\n");
        expect(impresso).not.toContain("segredo-do-cliente");
        expect(impresso).toContain("media.zapi.example");
      } finally {
        espioes.forEach((e) => e.mockRestore());
      }
    });
  });

  it("redirect: 302 devolve null, com redirect manual e sem Authorization", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    expect(await newtonBridgeAdapter.downloadMedia(REF)).toBeNull();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.redirect).toBe("manual");
    expect(Object.keys(init.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("o pedido não leva o token do bridge nem cookie", async () => {
    fetchMock.mockResolvedValue(resposta(JPEG));
    await newtonBridgeAdapter.downloadMedia(REF);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(JSON.stringify(init)).not.toContain("tok-teste");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("nenhum log traz a URL: só o host e o motivo", async () => {
    const espioes = (["warn", "error", "log", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      fetchMock.mockResolvedValueOnce(new Response("x", { status: 404 }));
      await newtonBridgeAdapter.downloadMedia(REF);
      fetchMock.mockResolvedValueOnce(resposta(Buffer.from("<html>")));
      await newtonBridgeAdapter.downloadMedia(REF);
      fetchMock.mockResolvedValueOnce(resposta(JPEG, { headers: { "content-length": String(MB3 + 1) } }));
      await newtonBridgeAdapter.downloadMedia(REF);
      // O wrapper de timeout põe host+caminho na mensagem do erro: não pode vazar.
      fetchMock.mockRejectedValueOnce(new Error(`timeout de 15000ms em media.zapi.example/instances/X/segredo-do-cliente/foto.jpeg`));
      await newtonBridgeAdapter.downloadMedia(REF);
      await newtonBridgeAdapter.downloadMedia("zapi:https://evil.example/instances/X/segredo-do-cliente/foto.jpeg");
      const saida = espioes.flatMap((s) => s.mock.calls.flat()).join(" ");
      expect(saida).not.toContain("segredo-do-cliente");
      expect(saida).not.toContain("foto.jpeg");
      expect(saida).toContain("media.zapi.example");
      expect(saida).toMatch(/http_404/);
    } finally {
      espioes.forEach((s) => s.mockRestore());
    }
  });
});

describe("idSintetico", () => {
  const base = { phone: "5511900000001", groupId: null, text: "oi", anexos: 0, agoraMs: 1_700_000_040_000 }; // início exato de um minuto

  it("mesma mensagem no mesmo minuto dá o mesmo id, com prefixo newton:", () => {
    const a = idSintetico(base);
    expect(a).toMatch(/^newton:[0-9a-f]{40}$/);
    expect(idSintetico({ ...base, agoraMs: base.agoraMs + 30_000 })).toBe(a);
  });

  it("mídia: sem ela (ausente, null ou vazia) o id é o de hoje; com ela muda, e dois arquivos não colidem", () => {
    const a = idSintetico(base);
    expect(idSintetico({ ...base, midia: null })).toBe(a);
    expect(idSintetico({ ...base, midia: "" })).toBe(a);
    const foto1 = idSintetico({ ...base, midia: "zapi:https://media.zapi.example/1.jpeg" });
    const foto2 = idSintetico({ ...base, midia: "zapi:https://media.zapi.example/2.jpeg" });
    expect(foto1).not.toBe(a);
    expect(foto1).not.toBe(foto2);
    expect(idSintetico({ ...base, midia: "zapi:https://media.zapi.example/1.jpeg" })).toBe(foto1);
    expect(foto1).toMatch(/^newton:[0-9a-f]{40}$/);
  });

  it("muda com minuto, texto, telefone, grupo ou anexos", () => {
    const a = idSintetico(base);
    expect(idSintetico({ ...base, agoraMs: base.agoraMs + 60_000 })).not.toBe(a);
    expect(idSintetico({ ...base, text: "oi!" })).not.toBe(a);
    expect(idSintetico({ ...base, phone: "5511999990000" })).not.toBe(a);
    expect(idSintetico({ ...base, groupId: "1203-group" })).not.toBe(a);
    expect(idSintetico({ ...base, anexos: 1 })).not.toBe(a);
  });
});

describe("textoDoBridge", () => {
  it("marcador sem conteúdo vira vazio; legenda e texto comum ficam", () => {
    expect(textoDoBridge("[imagem enviada]")).toBe("");
    expect(textoDoBridge(" [documento: sem nome] ")).toBe("");
    expect(textoDoBridge("[áudio enviado — transcrição indisponível, Whisper falhou]")).toBe("");
    expect(textoDoBridge("segue a matrícula")).toBe("segue a matrícula");
    expect(textoDoBridge("[imagem enviada] e mais isto")).toBe("[imagem enviada] e mais isto");
  });

  it("áudio transcrito vira só a transcrição", () => {
    expect(textoDoBridge("[áudio transcrito · 8.0KB]\nme liga amanhã")).toBe("me liga amanhã");
  });

  it("marca de citação e aviso do sanitize saem antes do resto", () => {
    expect(textoDoBridge("[respondendo a msg id=3EB0ABC] SIM")).toBe("SIM");
    expect(textoDoBridge("[respondendo a msg id=3EB0ABC] [imagem enviada]")).toBe("");
    const aviso = "[suspicious instruction-like content detected · patterns: ignore_previous]\n";
    expect(textoDoBridge(`${aviso}[respondendo a msg id=3EB0ABC] SIM`)).toBe("SIM");
    expect(textoDoBridge(`${aviso}[documento: x.pdf]`)).toBe("");
    expect(textoDoBridge(`${aviso}[áudio transcrito · 2.1KB]\nconfirmo`)).toBe("confirmo");
  });
});

describe("idDoBridge", () => {
  it("aceita id da Z-API e recusa vazio, curto, forjado ou fora do formato", () => {
    expect(idDoBridge("3EB0C431D8A1B2")).toBe("3EB0C431D8A1B2");
    expect(idDoBridge(" 3EB0C431D8A1B2 ")).toBe("3EB0C431D8A1B2");
    expect(idDoBridge("newton:abcdef")).toBeNull();
    expect(idDoBridge("abc")).toBeNull();
    expect(idDoBridge("id com espaço")).toBeNull();
    expect(idDoBridge(123)).toBeNull();
    expect(idDoBridge(undefined)).toBeNull();
  });
});
