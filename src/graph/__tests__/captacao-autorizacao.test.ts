import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  conduzirCaptacao,
  iniciarFilaDeAutorizacao,
  pedeFilaDeAutorizacao,
  captacaoAutorizacaoLigada,
  TEXTO_CAPTACAO_SEM_POLITICA,
  CODIGOS_DA_AUTORIZACAO,
  type FluxoCaptacao,
} from "../captacao";
import { rebaixarFluxo, type ContextoDoTurno, type DepsDoFluxo, type RespostaDoServidor } from "../fluxos";

/**
 * Fluxo de autorização de reaproveitamento pelo Max (v2/PR7, par do
 * contractmaker#1863): a oferta ao corretor (`captacao.autorizacao.pedir`) e a
 * fila do gerente (`captacao.autorizacao.listar`/`.decidir`).
 *
 * CASO NEGADO testado antes do permitido em cada bloco: sem a capability o Max
 * não oferece nem intercepta; com a flag desligada, o fluxo fica inerte.
 *
 * Deps mínimos (não o fake-server completo de `captacao.test.ts`): aqui o que
 * importa é o CONTRATO do verbo (args, idempotencyKey) e o texto para cada
 * status/código — não o ciclo de vida inteiro do rascunho.
 */

function ctxDe(texto: string, policy: string[], messageId = "msg-1"): ContextoDoTurno {
  return { texto, messageId, policy: policy as ContextoDoTurno["policy"], agora: Date.now() };
}

function depsCom(acao: DepsDoFluxo["acao"]): DepsDoFluxo {
  return {
    acao,
    extrairProposta: async () => null,
    extrairCampos: async () => null,
  };
}

const CPF_INTEIRO = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/;
const NOME_PROPRIETARIO = "Maria Silva";

beforeEach(() => {
  delete process.env.MAX_CAPTACAO_AUTORIZACAO;
});
afterEach(() => {
  delete process.env.MAX_CAPTACAO_AUTORIZACAO;
});

// ─── gatilho da fila (regex) ────────────────────────────────────────────

describe("pedeFilaDeAutorizacao", () => {
  it.each([
    "Tem pedido de autorização?",
    "tem pedidos de autorizacao",
    "pedidos pendentes",
    "pedidos de autorização pendentes",
    "autorizações pendentes",
    "fila de autorização",
    "Max, fila de autorizacao",
  ])("reconhece: %s", (t) => expect(pedeFilaDeAutorizacao(t)).toBe(true));

  it.each(["pedidos de compra pendentes", "quero autorização pra viajar", "como funciona a autorização?"])(
    "não casa texto fora do contexto: %s",
    (t) => expect(pedeFilaDeAutorizacao(t)).toBe(false)
  );
});

// ─── flag ───────────────────────────────────────────────────────────────

describe("captacaoAutorizacaoLigada (MAX_CAPTACAO_AUTORIZACAO)", () => {
  it("desligada por padrão", () => {
    expect(captacaoAutorizacaoLigada()).toBe(false);
  });
  it("liga com 1/true/on/sim", () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    expect(captacaoAutorizacaoLigada()).toBe(true);
  });
});

// ─── corretor: oferta e pedido ────────────────────────────────────────────

describe("corretor: oferta de autorização (verificar → autorizacao_oferta)", () => {
  const SEM_CAP = ["captacao.create"];
  const COM_CAP = ["captacao.create", "captacao.autorizacao.pedir"];

  function fluxoNaOferta(tipo: "proprietario" | "imovel" = "proprietario", ref = "p1"): FluxoCaptacao {
    return {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1", version: 3,
      autorizacaoPedido: { tipo, ref }, tentativas: 0, atualizadoEm: Date.now(),
    };
  }

  it("CASO NEGADO: sem a capability, a conferência NÃO oferece — cai no aviso genérico, sem nome/CPF", async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [{ codigo: "proprietario_aguarda_autorizacao", ref: "p1" }], emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const f: FluxoCaptacao = { kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now() };
    const passo = await conduzirCaptacao(f, ctxDe("sim", SEM_CAP), depsCom(acao), true);
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("verificar");
    expect(passo.reply).not.toContain("Quer que eu peça");
    expect(passo.reply).not.toMatch(CPF_INTEIRO);
    expect(passo.reply).not.toContain(NOME_PROPRIETARIO);
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("achado de review 19/10 (item 7): SEM a capability, o texto do bloqueio é o de ANTES desta mudança (fallback genérico), byte a byte — regressão", async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [{ codigo: "proprietario_aguarda_autorizacao", ref: "p1" }], emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const f: FluxoCaptacao = { kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now() };
    const passo = await conduzirCaptacao(f, ctxDe("sim", SEM_CAP), depsCom(acao), true);
    // Fallback literal de `bloqueioEmTexto` (código com "_" trocado por espaço) — o MESMO texto
    // de antes do v2/PR7, quando este código nem existia em `TEXTO_DO_BLOQUEIO`. O texto novo
    // ("este proprietário aguarda autorização do gerente...") só pode aparecer COM a capability.
    expect(passo.reply).toContain('pendência "proprietario aguarda autorizacao"');
    expect(passo.reply).not.toContain("aguarda autorização do gerente");
  });

  it("com a capability, oferece pedir — sem nome nem CPF do proprietário", async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [{ codigo: "proprietario_aguarda_autorizacao", ref: "p1" }], emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const f: FluxoCaptacao = { kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now() };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("Quer que eu peça a autorização");
    expect(passo.reply).not.toMatch(CPF_INTEIRO);
    expect(passo.reply).not.toContain(NOME_PROPRIETARIO);
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_oferta");
  });

  it('"imovel_autorizacao_negada" oferece pedir de novo, sem o motivo (o preflight não traz motivo)', async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [{ codigo: "imovel_autorizacao_negada", ref: "prop-9" }], emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const f: FluxoCaptacao = { kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now() };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("negada");
    expect(passo.reply).not.toContain("motivo");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_oferta");
  });

  it('"não" na oferta recusa sem chamar o verbo de pedir', async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("não", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("não vou pedir");
  });

  it('"sim" direto pede SEM justificativa, com a key = messageId da confirmação', async () => {
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.pedir");
      expect(args).toEqual({ captacaoId: "cap-1", tipo: "proprietario", ref: "p1" });
      expect(key).toBe("msg-confirma");
      return { status: 201, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP, "msg-confirma"), depsCom(acao), true);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(passo.reply).toContain("Pedido enviado ao seu gerente");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("verificar");
  });

  it('achado de review 19/10 (item 6): "sim, <justificativa>" confirma e pede DIRETO, levando a justificativa (sem o passo extra de confirmação)', async () => {
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.pedir");
      expect(args).toEqual({
        captacaoId: "cap-1", tipo: "proprietario", ref: "p1",
        justificativa: "o cliente pediu para eu continuar atendendo",
      });
      return { status: 201, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    const passo = await conduzirCaptacao(
      fluxoNaOferta(), ctxDe("sim, o cliente pediu para eu continuar atendendo", COM_CAP), depsCom(acao), true
    );
    expect(acao).toHaveBeenCalledTimes(1);
    expect(passo.reply).toContain("Pedido enviado ao seu gerente");
  });

  it('achado de review 19/10 (item 6): "sim - <justificativa>" (hífen) também confirma direto', async () => {
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>): Promise<RespostaDoServidor | null> => {
      expect(args).toMatchObject({ justificativa: "o cliente pediu pra eu atender, posso?" });
      return { status: 201, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    const passo = await conduzirCaptacao(
      fluxoNaOferta(), ctxDe("sim - o cliente pediu pra eu atender, posso?", COM_CAP), depsCom(acao), true
    );
    expect(acao).toHaveBeenCalledTimes(1);
    expect(passo.reply).toContain("Pedido enviado ao seu gerente");
  });

  it("justificativa livre (texto) pede confirmação verbatim antes de chamar o verbo", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar ainda"); });
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("o cliente pediu pra eu atender", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain('"o cliente pediu pra eu atender"');
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_oferta");
  });

  it("justificativa > 300 caracteres é recusada antes de perguntar confirmação", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const longa = "x".repeat(301);
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe(longa, COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("grande demais");
  });

  it("confirmando a justificativa, pede COM ela — key ainda é a messageId do sim final", async () => {
    const f: FluxoCaptacao = {
      ...fluxoNaOferta(), autorizacaoPedido: { tipo: "proprietario", ref: "p1", justificativa: "Cliente pediu" },
    };
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(args).toMatchObject({ justificativa: "Cliente pediu" });
      expect(key).toBe("msg-sim-2");
      return { status: 201, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    await conduzirCaptacao(f, ctxDe("sim", COM_CAP, "msg-sim-2"), depsCom(acao), true);
    expect(acao).toHaveBeenCalledTimes(1);
  });

  it("replay do MESMO messageId do sim produz a MESMA idempotency key (não gera segundo pedido com key nova)", async () => {
    const keys: (string | undefined)[] = [];
    const acao = vi.fn(async (_verb: string, _args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      keys.push(key);
      return { status: 200, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    const ctx = ctxDe("sim", COM_CAP, "msg-replay");
    await conduzirCaptacao(fluxoNaOferta(), ctx, depsCom(acao), true);
    await conduzirCaptacao(fluxoNaOferta(), ctx, depsCom(acao), true);
    expect(keys).toEqual(["msg-replay", "msg-replay"]);
  });

  it("achado de review 19/10 (item 2): SEM resposta, o próximo \"sim\" (messageId NOVO) repete a MESMA chave guardada, não uma chave nova", async () => {
    const keys: (string | undefined)[] = [];
    let chamada = 0;
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.pedir");
      keys.push(key);
      chamada++;
      if (chamada === 1) return null; // sem resposta do servidor
      expect(args).toEqual({ captacaoId: "cap-1", tipo: "proprietario", ref: "p1" });
      return { status: 201, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } };
    });
    const passo1 = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP, "msg-um"), depsCom(acao), true);
    expect(passo1.reply).toContain("não duplica");
    const f2 = passo1.fluxo as FluxoCaptacao;
    expect(f2.kind === "captacao" ? f2.autorizacaoChave?.valor : null).toBe("msg-um");
    // Mensagem NOVA do WhatsApp chega com messageId DIFERENTE — sem a correção, isso geraria
    // uma chave nova (e, no servidor real, um segundo pedido de autorização).
    const passo2 = await conduzirCaptacao(f2, ctxDe("sim", COM_CAP, "msg-dois"), depsCom(acao), true);
    expect(keys).toEqual(["msg-um", "msg-um"]);
    expect(passo2.reply).toContain("Pedido enviado ao seu gerente");
  });

  it("200 (já pendente) diz que já tem pedido aguardando", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> =>
      ({ status: 200, body: { autorizacao: { id: "aut-1", status: "pendente" }, tipo: "proprietario", ref: "p1" } })
    );
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe("Já tem um pedido aguardando o gerente.");
  });

  it("409 nao_precisa_autorizacao refaz o preflight (chama de novo) em vez de só avisar", async () => {
    let chamadaPreflight = 0;
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.autorizacao.pedir") return { status: 409, body: { error: "nao_precisa_autorizacao" } };
      if (verb === "captacao.preflight") {
        chamadaPreflight++;
        return { status: 200, body: { pronto: true, faltantes: [], pendentesFicha: [], bloqueios: [], emBranco: 0, version: 4 } };
      }
      if (verb === "captacao.options") return null; // `resumir` tolera `null` (sem resposta).
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(chamadaPreflight).toBe(1);
    expect(passo.reply).toContain("Não é mais necessário pedir");
  });

  it("404 diz que não achou a captação — corpo REAL do servidor (NAO_ENCONTRADA = {error:\"Not Found\"})", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 404, body: { error: "Not Found" } }));
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("Não achei essa captação");
    expect(passo.fluxo).toBeNull();
  });

  it("422 documento_invalido usa o texto do código, sem PII", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 422, body: { error: "documento_invalido" } }));
    const passo = await conduzirCaptacao(fluxoNaOferta(), ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("documento válido");
    expect(passo.reply).not.toMatch(CPF_INTEIRO);
  });

  // ── achado de review 19/10: com 2 bloqueios, o 1º já pedido some da oferta ──

  function preflightComDoisBloqueios(acao: ReturnType<typeof vi.fn>): void {
    acao.mockImplementation(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [
              { codigo: "proprietario_aguarda_autorizacao", ref: "p1" },
              { codigo: "proprietario_aguarda_autorizacao", ref: "p2" },
            ],
            emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
  }

  it("com 2 proprietários bloqueados, depois que o 1º já foi pedido o 2º É oferecido (antes sempre voltava ao 1º)", async () => {
    const acao = vi.fn();
    preflightComDoisBloqueios(acao);
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoPedidosFeitos: ["p1"],
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("Quer que eu peça a autorização");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_oferta");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.autorizacaoPedido?.ref : null).toBe("p2");
  });

  it("pedir o 2º adiciona ao conjunto de já-pedidos sem perder o 1º", async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.pedir");
      return { status: 201, body: { autorizacao: { id: "aut-2", status: "pendente" }, tipo: "proprietario", ref: "p2" } };
    });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1", version: 3,
      autorizacaoPedido: { tipo: "proprietario", ref: "p2" }, autorizacaoPedidosFeitos: ["p1"],
      tentativas: 0, atualizadoEm: Date.now(),
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.autorizacaoPedidosFeitos : null).toEqual(["p1", "p2"]);
  });

  it("quando os dois já foram pedidos, não oferece de novo — diz só que aguardam o gerente", async () => {
    const acao = vi.fn();
    preflightComDoisBloqueios(acao);
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "verificar", captacaoId: "cap-1", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoPedidosFeitos: ["p1", "p2"],
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).not.toContain("Quer que eu peça");
    expect(passo.reply).toContain("aguarda autorização do gerente");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("verificar");
  });

  it('achado de review 19/10 (item 3): "não" na oferta guarda o `ref` recusado e NÃO reoferece no próximo "sim" — sem loop', async () => {
    const acao = vi.fn(async (verb: string): Promise<RespostaDoServidor | null> => {
      if (verb === "captacao.preflight") {
        return {
          status: 200,
          body: {
            pronto: false, faltantes: [], pendentesFicha: [],
            bloqueios: [{ codigo: "proprietario_aguarda_autorizacao", ref: "p1" }], emBranco: 0, version: 3,
          },
        };
      }
      throw new Error(`verbo inesperado: ${verb}`);
    });
    const passo1 = await conduzirCaptacao(fluxoNaOferta(), ctxDe("não", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo1.fluxo?.kind === "captacao" ? passo1.fluxo.autorizacaoPedidosRecusados : null).toEqual(["p1"]);
    // Próximo "sim" (volta pra `verificar`, refaz o preflight): sem a correção, reoferecia o
    // MESMO ref de novo — em loop. Com a correção, cai no bloqueio genérico.
    const passo2 = await conduzirCaptacao(passo1.fluxo as FluxoCaptacao, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo2.reply).not.toContain("Quer que eu peça");
    expect(passo2.reply).toContain("aguarda autorização do gerente");
    expect(passo2.fluxo?.kind === "captacao" ? passo2.fluxo.etapa : null).toBe("verificar");
  });
});

// ─── gerente: fila, aprovar, negar ────────────────────────────────────────

describe("gerente: fila de autorização", () => {
  const COM_CAP = ["captacao.autorizacao.decidir"];

  it("CASO NEGADO: sem a capability, não intercepta — nem chega a checar a flag", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const passo = await iniciarFilaDeAutorizacao(ctxDe("tem pedido de autorização?", []), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toBe(TEXTO_CAPTACAO_SEM_POLITICA);
  });

  it("CASO NEGADO: flag desligada (mesmo com a capability) é inerte — não chama o verbo", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const passo = await iniciarFilaDeAutorizacao(ctxDe("pedidos pendentes", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("não está ligada");
  });

  it("lista vazia diz 'Nenhum pedido aguardando você.' e não inicia fluxo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 200, body: { items: [], total: 0 } }));
    const passo = await iniciarFilaDeAutorizacao(ctxDe("pedidos pendentes", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe("Nenhum pedido aguardando você.");
    expect(passo.fluxo).toBeNull();
  });

  it("lista com itens numera e nunca mostra CPF inteiro nem nome do dono da carteira", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({
      status: 200,
      body: {
        items: [
          { ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**", criadoEm: "2026-10-19T12:00:00.000Z" },
        ],
        total: 1,
      },
    }));
    const passo = await iniciarFilaDeAutorizacao(ctxDe("pedidos pendentes", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("1. CAP-2026-0007");
    expect(passo.reply).toContain("Ana Souza");
    expect(passo.reply).not.toMatch(CPF_INTEIRO);
    expect(passo.reply).not.toContain(NOME_PROPRIETARIO);
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_fila");
  });

  it("403 do listar: 'você não tem pedidos para decidir', sem chamar decidir", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 403, body: {} }));
    const passo = await iniciarFilaDeAutorizacao(ctxDe("pedidos pendentes", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("não tem pedidos de autorização");
    expect(passo.fluxo).toBeNull();
  });

  function fluxoNaFila(): FluxoCaptacao {
    return {
      kind: "captacao", etapa: "autorizacao_fila", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoFila: {
        itens: [
          { ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
          { ref: 2, id: "aut-2", tipo: "imovel", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
        ],
      },
    };
  }

  it("'aprovar 1' pede confirmação identificando quem e o quê (achado de review 19/10), ainda sem chamar decidir", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar ainda"); });
    const passo = await conduzirCaptacao(fluxoNaFila(), ctxDe("aprovar 1", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("Autorizar Ana Souza a captar com o proprietário ***.456.789-** na CAP-2026-0007?");
    expect(passo.reply).not.toContain("Autorizar o pedido 1");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_confirmar");
  });

  it("'aprovar 2' (imóvel) identifica pelo imóvel, não pelo documento", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar ainda"); });
    const passo = await conduzirCaptacao(fluxoNaFila(), ctxDe("aprovar 2", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("Autorizar Bruno Lima a captar com o imóvel Rua Augusta, 1250 na CAP-2026-0008?");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_confirmar");
  });

  it("'sim' depois de 'aprovar 1' chama decidir com decisao=aprovar e key = messageId do sim", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.decidir");
      expect(args).toEqual({ autorizacaoId: "aut-1", decisao: "aprovar" });
      expect(key).toBe("msg-aprova");
      return { status: 200, body: { autorizacao: { id: "aut-1", status: "aprovada" } } };
    });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP, "msg-aprova"), depsCom(acao), true);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(passo.reply).toBe("Pedido aprovado.");
  });

  it("'negar 2' pede o motivo — NÃO chama o verbo nesta etapa", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const passo = await conduzirCaptacao(fluxoNaFila(), ctxDe("negar 2", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("motivo");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_motivo");
  });

  it("negar SEM motivo (texto vazio) não avança nem chama o verbo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_motivo", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("   ", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_motivo");
  });

  it("motivo > 500 caracteres é recusado, sem avançar nem chamar o verbo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_motivo", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("x".repeat(501), COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("grande demais");
  });

  it("motivo válido pede confirmação VERBATIM, ainda sem chamar o verbo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar ainda"); });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_motivo", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("documento com divergência de assinatura", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain('"documento com divergência de assinatura"');
    // Negar confirma com o MESMO identificador do aprovar (achado de review 19/10).
    expect(passo.reply).toContain("Bruno Lima");
    expect(passo.reply).toContain("Rua Augusta, 1250");
    expect(passo.reply).toContain("CAP-2026-0008");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_confirmar");
  });

  it('achado de review 19/10 (item 5): motivo com "desisto"/"não quero mais" NO MEIO da frase é motivo — não cancela, e não é roubado por `pedeCaptacao`', async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_motivo", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const motivo = "o cliente desistiu da captação, não quero mais atender esse pedido";
    const passo = await conduzirCaptacao(f, ctxDe(motivo, COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).not.toContain("Parei."); // não foi tratado como CANCELA do fluxo inteiro
    expect(passo.reply).toContain(`"${motivo}"`);
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_confirmar");
  });

  it('achado de review 19/10 (item 5): só "cancelar"/"cancela" EXATOS cancelam a decisão nesta etapa', async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => { throw new Error("não deveria chamar"); });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_motivo", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("cancelar", COM_CAP), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toBe("Tudo bem, não decidi nada.");
    expect(passo.fluxo).toBeNull();
  });

  it("'sim' confirmando a negativa chama decidir com decisao=negar, motivo e key do sim", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.decidir");
      expect(args).toEqual({ autorizacaoId: "aut-2", decisao: "negar", motivo: "Documento incompleto" });
      expect(key).toBe("msg-nega");
      return { status: 200, body: { autorizacao: { id: "aut-2", status: "negada" } } };
    });
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", motivo: "Documento incompleto", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP, "msg-nega"), depsCom(acao), true);
    expect(acao).toHaveBeenCalledTimes(1);
    expect(passo.reply).toBe("Pedido negado.");
  });

  it("404 do decidir: 'esse pedido não está mais com você' — corpo REAL do servidor (achado de review 19/10)", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    // NAO_ENCONTRADA real do servidor: {status:404, body:{error:"Not Found"}}. Antes da
    // correção, o `if (erro)` genérico rodava ANTES do 404 específico e tratava
    // "Not Found" como se fosse um código da autorização, caindo no fallback
    // "Não consegui processar o pedido. Veja na tela: " com LINK VAZIO.
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 404, body: { error: "Not Found" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe("Esse pedido não está mais com você.");
    expect(passo.reply).not.toContain("Veja na tela: ");
    expect(passo.reply).not.toContain("Não consegui processar o pedido");
  });

  it("403 RBAC (FORBIDDEN = {error:\"Forbidden\"}) do decidir usa textoDeNegado, não o texto por código", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 403, body: { error: "Forbidden" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe(TEXTO_CAPTACAO_SEM_POLITICA);
    expect(passo.reply).not.toContain("Veja na tela: ");
    expect(passo.reply).not.toContain("Não consegui processar o pedido");
  });

  // Achado de review 19/10 (item 4): o mock anterior usava `{error:"Forbidden"}` para
  // representar TAMBÉM o `POLITICA_NAO_CONCEDE` do servidor — corpo real (`lib/max/scope-action-comum.ts`,
  // conferido em `docs/max.md` §18.1/§18.7): `403 {error:"politica_nao_concede"}`.
  it("403 de política (POLITICA_NAO_CONCEDE = {error:\"politica_nao_concede\"}, corpo REAL do servidor) do decidir usa textoDeNegado", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 403, body: { error: "politica_nao_concede" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe(TEXTO_CAPTACAO_SEM_POLITICA);
    expect(passo.reply).not.toContain("Veja na tela: ");
    expect(passo.reply).not.toContain("Não consegui processar o pedido");
  });

  it("409 nao_pendente: 'esse pedido já foi decidido'", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 409, body: { error: "nao_pendente" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toBe("Esse pedido já foi decidido.");
  });

  it("403 solicitante_nao_decide: 'quem pediu não pode decidir o próprio pedido'", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 403, body: { error: "solicitante_nao_decide" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("Quem pediu não pode decidir");
  });

  it("422 motivo_obrigatorio volta pra etapa de motivo (recuperável), em vez de encerrar o fluxo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 422, body: { error: "motivo_obrigatorio" } }));
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-2", tipo: "imovel", decisao: "negar", codigo: "CAP-2026-0008", solicitante: "Bruno Lima", imovel: "Rua Augusta, 1250" },
    };
    const passo = await conduzirCaptacao(f, ctxDe("sim", COM_CAP), depsCom(acao), true);
    expect(passo.reply).toContain("preciso de um motivo");
    expect(passo.fluxo?.kind === "captacao" ? passo.fluxo.etapa : null).toBe("autorizacao_motivo");
  });

  it("achado de review 19/10 (item 2): SEM resposta do decidir, o próximo \"sim\" (messageId NOVO) repete a MESMA chave guardada", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const keys: (string | undefined)[] = [];
    let chamada = 0;
    const acao = vi.fn(async (verb: string, args: Record<string, unknown>, key?: string): Promise<RespostaDoServidor | null> => {
      expect(verb).toBe("captacao.autorizacao.decidir");
      keys.push(key);
      chamada++;
      if (chamada === 1) return null; // sem resposta do servidor
      expect(args).toEqual({ autorizacaoId: "aut-1", decisao: "aprovar" });
      return { status: 200, body: { autorizacao: { id: "aut-1", status: "aprovada" } } };
    });
    const f1: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
    };
    const passo1 = await conduzirCaptacao(f1, ctxDe("sim", COM_CAP, "msg-tres"), depsCom(acao), true);
    expect(passo1.reply).toContain("não duplica");
    const f2 = passo1.fluxo as FluxoCaptacao;
    expect(f2.kind === "captacao" ? f2.autorizacaoChave?.valor : null).toBe("msg-tres");
    const passo2 = await conduzirCaptacao(f2, ctxDe("sim", COM_CAP, "msg-quatro"), depsCom(acao), true);
    expect(keys).toEqual(["msg-tres", "msg-tres"]);
    expect(passo2.reply).toBe("Pedido aprovado.");
  });

  // ── achado de review 19/10 (item 1): nenhum código de autorização pode terminar a fala
  // com link vazio ("Tente pela tela: " sem nada depois), em pedir OU decidir. ──
  describe("nenhum CODIGOS_DA_AUTORIZACAO termina a fala em link vazio", () => {
    const COM_CAP_PEDIR = ["captacao.autorizacao.pedir"];

    function fluxoPedir(): FluxoCaptacao {
      return {
        kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1", version: 3,
        autorizacaoPedido: { tipo: "proprietario", ref: "p1" }, tentativas: 0, atualizadoEm: Date.now(),
      };
    }
    function fluxoDecidir(): FluxoCaptacao {
      return {
        kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(),
        autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "aprovar", codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" },
      };
    }

    it.each(CODIGOS_DA_AUTORIZACAO)('pedir: código "%s" nunca termina em link vazio', async (codigo) => {
      const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 422, body: { error: codigo } }));
      const passo = await conduzirCaptacao(fluxoPedir(), ctxDe("sim", COM_CAP_PEDIR), depsCom(acao), true);
      expect(passo.reply).not.toMatch(/:\s*$/);
      expect(passo.reply).not.toContain("tela: \n");
    });

    it.each(CODIGOS_DA_AUTORIZACAO)('decidir: código "%s" nunca termina em link vazio', async (codigo) => {
      process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
      const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => ({ status: 422, body: { error: codigo } }));
      const passo = await conduzirCaptacao(fluxoDecidir(), ctxDe("sim", COM_CAP), depsCom(acao), true);
      expect(passo.reply).not.toMatch(/:\s*$/);
      expect(passo.reply).not.toContain("tela: \n");
    });
  });
});

// ─── rebaixarFluxo (interrupção não deixa etapa que escreve pendente) ────

describe("rebaixarFluxo cobre as etapas novas que escrevem (v2/PR7)", () => {
  const agora = Date.now();

  it("autorizacao_oferta volta pra verificar e descarta o pedido em curso", () => {
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1",
      autorizacaoPedido: { tipo: "proprietario", ref: "p1" }, tentativas: 0, atualizadoEm: agora,
    };
    const r = rebaixarFluxo(f);
    expect(r).toMatchObject({ kind: "captacao", etapa: "verificar", pausado: false });
    expect((r as FluxoCaptacao).autorizacaoPedido).toBeUndefined();
  });

  it("achado de review 19/10 (item 2): com `autorizacaoChave` pendente (retry sem resposta), a interrupção NÃO rebaixa a etapa — só despausa", () => {
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1",
      autorizacaoPedido: { tipo: "proprietario", ref: "p1" },
      autorizacaoChave: { valor: "msg-um", args: { captacaoId: "cap-1", tipo: "proprietario", ref: "p1" } },
      tentativas: 0, atualizadoEm: agora, pausado: true,
    };
    const r = rebaixarFluxo(f) as FluxoCaptacao;
    expect(r).toMatchObject({ kind: "captacao", etapa: "autorizacao_oferta", pausado: false });
    expect(r.autorizacaoPedido).toEqual({ tipo: "proprietario", ref: "p1" });
    expect(r.autorizacaoChave).toEqual({ valor: "msg-um", args: { captacaoId: "cap-1", tipo: "proprietario", ref: "p1" } });
  });

  it.each(["autorizacao_motivo", "autorizacao_confirmar"] as const)(
    "%s volta pra autorizacao_fila e descarta a decisão em curso",
    (etapa) => {
      const f: FluxoCaptacao = {
        kind: "captacao", etapa,
        autorizacaoFila: { itens: [{ ref: 1, id: "aut-1", tipo: "proprietario", codigo: "CAP-2026-0007", solicitante: "Ana Souza" }] },
        autorizacaoDecisao: { autorizacaoId: "aut-1", tipo: "proprietario", decisao: "negar", motivo: "x", codigo: "CAP-2026-0007", solicitante: "Ana Souza" },
        tentativas: 0, atualizadoEm: agora,
      };
      const r = rebaixarFluxo(f);
      expect(r).toMatchObject({ kind: "captacao", etapa: "autorizacao_fila", pausado: false });
      expect((r as FluxoCaptacao).autorizacaoDecisao).toBeUndefined();
    }
  );

  it("autorizacao_fila (sem decisão pendente) não precisa rebaixar — fica como está", () => {
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_fila", autorizacaoFila: { itens: [] }, tentativas: 0, atualizadoEm: agora,
    };
    expect(rebaixarFluxo(f)).toMatchObject({ kind: "captacao", etapa: "autorizacao_fila" });
  });
});

// ─── review 19/10 (3ª rodada): escrita incerta nunca vira "nada aconteceu" ────
describe("pedir/decidir sem resposta: parar não afirma que nada foi gravado", () => {
  const CHAVE = { valor: "msg-um", args: { autorizacaoId: "aut-1", decisao: "aprovar" } };
  const DECISAO = { autorizacaoId: "aut-1", tipo: "proprietario" as const, decisao: "aprovar" as const, codigo: "CAP-2026-0007", solicitante: "Ana Souza", documento: "***.456.789-**" };

  it("'não' no confirmar do gerente depois de decidir sem resposta avisa que pode ter chegado, sem chamar o verbo", async () => {
    process.env.MAX_CAPTACAO_AUTORIZACAO = "true";
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => null);
    const f: FluxoCaptacao = { kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(), autorizacaoDecisao: DECISAO, autorizacaoChave: CHAVE };
    const passo = await conduzirCaptacao(f, ctxDe("não", ["captacao.autorizacao.decidir"]), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("pode ter chegado ao sistema");
    expect(passo.reply).not.toContain("não decidi nada");
  });

  it("'não' na oferta do corretor depois de pedir sem resposta avisa que pode ter chegado", async () => {
    const acao = vi.fn(async (): Promise<RespostaDoServidor | null> => null);
    const f: FluxoCaptacao = {
      kind: "captacao", etapa: "autorizacao_oferta", captacaoId: "cap-1", version: 3, tentativas: 0, atualizadoEm: Date.now(),
      autorizacaoPedido: { tipo: "proprietario", ref: "p1" },
      autorizacaoChave: { valor: "msg-um", args: { captacaoId: "cap-1", tipo: "proprietario", ref: "p1" } },
    };
    const passo = await conduzirCaptacao(f, ctxDe("não", ["captacao.autorizacao.pedir"]), depsCom(acao), true);
    expect(acao).not.toHaveBeenCalled();
    expect(passo.reply).toContain("pode ter chegado ao sistema");
    expect(passo.reply).not.toContain("não vou pedir");
  });

  it("chave da autorização NÃO segura revisao/brancos no rebaixarFluxo (o 'enviar' seguinte refaz o resumo)", () => {
    for (const etapa of ["revisao", "brancos"] as const) {
      const f: FluxoCaptacao = { kind: "captacao", etapa, captacaoId: "cap-1", version: 3, tentativas: 0, atualizadoEm: Date.now(), autorizacaoChave: CHAVE };
      const r = rebaixarFluxo(f) as FluxoCaptacao;
      expect(r.etapa).toBe("verificar");
    }
  });

  it("chave da autorização mantém a etapa da própria autorização no rebaixarFluxo (retry com a mesma chave)", () => {
    const f: FluxoCaptacao = { kind: "captacao", etapa: "autorizacao_confirmar", tentativas: 0, atualizadoEm: Date.now(), autorizacaoDecisao: DECISAO, autorizacaoChave: CHAVE };
    const r = rebaixarFluxo(f) as FluxoCaptacao;
    expect(r.etapa).toBe("autorizacao_confirmar");
    expect(r.autorizacaoChave).toEqual(CHAVE);
  });
});
