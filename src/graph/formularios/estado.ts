/**
 * Estado do fluxo v2 dos formulários pelo WhatsApp (proposta; a captação v2 usa
 * `FluxoCaptacao.versao`).
 *
 * O estado vai para o CHECKPOINT. Regra de PII (Global Constraint 6): nada de
 * CPF, RG, e-mail, telefone ou texto de documento aqui. Do que foi lido de
 * mídia guardam-se só o caminho do campo (`path`) e uma referência opaca
 * (`ref`, o id da mensagem de mídia): o valor lido vive na ficha do turno, nunca
 * no checkpoint.
 */

export type VersaoDoFluxo = 1 | 2;

export type EtapaV2 = "entender" | "compor" | "ficha" | "revisar" | "assinatura" | "envio" | "correcao";

/** O campo que a próxima resposta curta preenche ("123.456.789-09" sem dizer de quê). */
export interface CampoAguardado {
  /** Posição + papel da parte (`proponente:1`) ou `imovel`/`negociacao`/`corretor`. Nunca nome. */
  parteRef: string;
  /** O campo como o servidor o nomeia no `faltando` (`proponente.documento`, `negociacao.valor`, `proprietarios[1].cpf`). */
  path: string;
}

export interface FluxoFormularioV2 {
  kind: "proposta_v2";
  versao: 2;
  esteira: "venda" | "locacao";
  /** Só depois do `proposal.create`. */
  proposalId?: string;
  /** `schemaType` escolhido (obrigatório no create v2). */
  schemaType?: string;
  etapa: EtapaV2;
  aguardaCampo?: CampoAguardado;
  /** Instante da última entrada do corretor: base da pausa antes da ficha (D2). */
  ultimaEntradaEm: number;
  /** Leitura de mídia não confirmada: só caminho + referência, sem valor. */
  lidosPendentes: Array<{ path: string; ref: string }>;
  /**
   * O VALOR do que `lidosPendentes` aponta, cifrado (AES-256-GCM, chave derivada da
   * `MAX_ENCRYPTION_KEY`, amarrado à thread): o checkpoint nunca tem valor lido em
   * claro. Só `midia.ts` abre. Some quando `lidosPendentes` esvazia.
   */
  cofreLidos?: string;
  /** Campos já perguntados (para não repetir a mesma pergunta). Só caminhos. */
  perguntados: string[];
  /** A escrita em curso: a `messageId` do primeiro "sim" (Global Constraint 5). */
  chave?: { verbo: string; valor: string };
  /**
   * Quantas mensagens do corretor, ANTES da atual, pertencem a este fluxo. Começa em 0
   * (a mensagem que abriu é a atual daquele turno) e sobe 1 a cada turno tratado
   * (`contarEntradaDoFluxo`). A janela de extração só olha para essa quantidade de
   * mensagens: o que o corretor disse antes de o fluxo abrir (outra proposta, outro
   * comprador) não entra. Contagem, não índice: a compactação do histórico não a
   * desalinha (só pode encurtar a janela). Ausente em checkpoint antigo = 0.
   */
  mensagensDoFluxo?: number;
  /** Todo `Fluxo` carrega isto: TTL e expiração. */
  atualizadoEm: number;
}

export function novoFluxoV2(args: {
  esteira: "venda" | "locacao";
  agora: number;
  schemaType?: string;
}): FluxoFormularioV2 {
  return {
    kind: "proposta_v2",
    versao: 2,
    esteira: args.esteira,
    schemaType: args.schemaType,
    etapa: "entender",
    ultimaEntradaEm: args.agora,
    lidosPendentes: [],
    perguntados: [],
    mensagensDoFluxo: 0,
    atualizadoEm: args.agora,
  };
}

/** Chamado uma vez por turno em que o fluxo tratou uma fala do corretor (a atual vira "anterior" no próximo). */
export function contarEntradaDoFluxo(f: FluxoFormularioV2): FluxoFormularioV2 {
  return { ...f, mensagensDoFluxo: (f.mensagensDoFluxo ?? 0) + 1 };
}
