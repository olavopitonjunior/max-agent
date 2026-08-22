import { describe, it, expect, vi, afterEach } from "vitest";
import { conversationKey, maskPhone, normalizeBrPhone, phoneTag } from "../phone";

/**
 * `maskPhone` é da TELA do super-admin, não do log. Lá ela é o certo: a página
 * já mostra a transcrição inteira ao lado, e os 4 finais são o que casa o turn
 * com a carteira de corretores do tenant.
 */
describe("maskPhone", () => {
  it("mantém DDI+DDD e os 4 finais", () => {
    expect(maskPhone("5511987654321")).toBe("5511***4321");
    expect(maskPhone("+5511987654321")).toBe("5511***4321");
  });

  it("curto demais vira só asteriscos — nada a correlacionar", () => {
    expect(maskPhone("123456")).toBe("***");
    expect(maskPhone("")).toBe("***");
  });

  it("7-8 dígitos também: prefixo+sufixo devolveria o número quase inteiro", () => {
    expect(maskPhone("12345678")).toBe("***");
    expect(maskPhone("1234567")).toBe("***");
  });
});

/**
 * `phoneTag` é do LOG, e o que ele promete é diferente do que a máscara
 * prometia. Log da Vercel é retido e pesquisável fora do nosso controle de
 * acesso, então a meta aqui não é "esconder parte", é **não sair dígito
 * nenhum** — mantendo a única coisa que o log precisa do telefone, que é
 * correlacionar a mesma pessoa entre eventos.
 *
 * A máscara falhava nas duas pontas: vazava os 4 finais (que, dentro de uma
 * carteira de dezenas de corretores, já identificam) e escondia só ~4 dígitos
 * de fato, porque o primeiro de um celular BR é sempre `9`.
 */
describe("phoneTag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("não devolve nenhum dígito do número", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-teste");
    const rotulo = phoneTag("+5511987654321");

    for (const pedaco of ["5511987654321", "987654321", "87654321", "4321", "5511"]) {
      expect(rotulo).not.toContain(pedaco);
    }
    expect(rotulo).toMatch(/^tel_[0-9a-f]{10}$/);
  });

  /**
   * O ponto inteiro da função. Se o rótulo dependesse do formato do telefone, o
   * log repetiria dentro de si o bug de identidade de 21/08 — a mesma pessoa
   * apareceria como duas, e ninguém veria.
   */
  it("toda forma do mesmo número dá o MESMO rótulo", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-teste");
    const esperado = phoneTag("5511987654321");

    for (const forma of ["+5511987654321", "11987654321", "(11) 98765-4321", " +55 11 98765-4321 "]) {
      expect(phoneTag(forma)).toBe(esperado);
    }
  });

  it("pessoas diferentes têm rótulos diferentes", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-teste");
    expect(phoneTag("+5511987654321")).not.toBe(phoneTag("+5511987654322"));
  });

  /**
   * É a chave que torna o pseudônimo irreversível: o espaço de celulares
   * brasileiros é pequeno o bastante para um hash SEM chave ser quebrado por
   * força bruta em segundos. Este teste falha se alguém trocar o HMAC por um
   * hash puro "para simplificar".
   */
  it("depende do segredo — sem ele não seria pseudônimo, seria hash quebrável", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "segredo-A");
    const comA = phoneTag("+5511987654321");
    vi.stubEnv("MAX_NOTIFY_SECRET", "segredo-B");

    expect(phoneTag("+5511987654321")).not.toBe(comA);
  });

  it("entrada vazia não vira rótulo válido nem lança", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "s-teste");
    expect(phoneTag("")).toBe("tel_vazio");
  });

  /**
   * Sem segredo, a chave vira uma constante versionada no repositório — o que
   * é o mesmo que não ter chave, e volta a ser quebrável por força bruta.
   * Acontece em desenvolvimento e teste, onde não há o que proteger, mas também
   * aconteceria num cron ou script de produção mal configurado.
   *
   * O prefixo diferente existe para esse caso não ser silencioso: `telx_` no
   * log de produção é bug de configuração, não rótulo para investigar.
   */
  it("sem segredo o rótulo se declara: telx_, não tel_", () => {
    vi.stubEnv("MAX_NOTIFY_SECRET", "");
    expect(phoneTag("+5511987654321")).toMatch(/^telx_[0-9a-f]{10}$/);
  });
});

describe("normalizeBrPhone", () => {
  it("normaliza com e sem DDI", () => {
    expect(normalizeBrPhone("5511987654321")).toBe("+5511987654321");
    expect(normalizeBrPhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("123")).toBeNull();
  });
});

/**
 * O bug que esta função corrige aconteceu de verdade, em 21/08, no primeiro dia
 * de conversa em produção: a mesma pessoa apareceu em DUAS threads e DUAS
 * memórias porque o webhook da Z-API entrega `5511…` e um chamador que
 * normalizava antes entregava `+5511…`. Nada falhou, nada logou — só existiam
 * dois Olavos.
 *
 * Por isso o teste central aqui não é "formata certo", é **"formas diferentes
 * da mesma pessoa colapsam na mesma chave"**.
 */
describe("conversationKey", () => {
  it("toda forma de escrever o mesmo número dá a MESMA chave", () => {
    const esperado = "5511987654321";
    for (const forma of [
      "5511987654321",
      "+5511987654321",
      "11987654321",
      "(11) 98765-4321",
      " +55 11 98765-4321 ",
    ]) {
      expect(conversationKey(forma)).toBe(esperado);
    }
  });

  it("números diferentes continuam diferentes", () => {
    expect(conversationKey("+5511987654321")).not.toBe(
      conversationKey("+5511987654322")
    );
  });

  it("é a mesma forma que a Z-API entrega — a semeadura depende disso", () => {
    // `outbox.phone` e `inbound_queue.from_phone` são gravados sem "+". Se a
    // chave divergisse, `seedNotification` semearia uma thread que a conversa
    // nunca lê — a falha mais silenciosa possível.
    expect(conversationKey("+5511987654321")).toBe("5511987654321");
  });

  it("número que não normaliza vira dígitos crus, nunca vazio", () => {
    // Determinismo importa mais que formato: um número que o
    // `normalizeBrPhone` recusa não resolve identidade e não chega a abrir
    // thread — mas a chave ainda não pode colidir entre pessoas diferentes,
    // nem virar string vazia (que colidiria com TODOS eles).
    expect(conversationKey("+44 20 7946 0958")).toBe("442079460958");
    expect(conversationKey("")).toBe("");
  });

  /**
   * Comportamento HERDADO do `normalizeBrPhone`, documentado aqui porque
   * surpreende: um número estrangeiro de 11 dígitos tem o mesmo comprimento de
   * um celular BR, então ele é adotado como brasileiro e ganha `55` na frente.
   *
   * Não é bug desta função e não afeta o que ela promete — a chave continua
   * determinística e distinta por número. Fica registrado para quem investigar
   * "por que o telefone do gringo virou DDD 14": o lugar é `normalizeBrPhone`,
   * não aqui.
   */
  it("estrangeiro de 11 dígitos é indistinguível de celular BR (herdado)", () => {
    expect(conversationKey("+1 415 555 0100")).toBe("5514155550100");
  });
});
