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

/** Passo da revisão (T11/T12): um Flow (ou uma lista numerada) por passo. */
export type PassoDeRevisao = "partes" | "imovel_valor" | "assinatura";

/**
 * A revisão em curso (T11/T12). Só caminhos canônicos do rascunho (`compradores[0].cpf`):
 * nunca valor. `itens` é a numeração da lista ("2 Maria Souza" = o 2º caminho). `via`: `flow`
 * (Max, o Flow do passo já foi enviado) ou `texto` (lista numerada: Newton, ou Max sem Flow).
 */
export interface RevisaoEmCurso {
  passo: PassoDeRevisao;
  via: "flow" | "texto";
  itens: string[];
}

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
  /**
   * Valor de `mensagensDoFluxo` no recomeço da janela de extração: depois do SIM (gravou) ou do
   * NÃO (descartou) o que veio antes já foi resolvido e não pode ser extraído de novo (I3). A
   * janela passada ao modelo tem `mensagensDoFluxo - janelaDesde` mensagens. Ausente = desde o início.
   */
  janelaDesde?: number;
  /**
   * Quando a ficha agendada na pausa (T10) foi marcada para sair pelo outbox. É só o agendamento:
   * o horário NÃO prova que o corretor viu a ficha (o cron pode atrasar ou a linha ser cancelada).
   * O "sim" só vale depois de `pausa.entregue` confirmar a linha enviada. Sem dado pessoal.
   */
  fichaAgendadaEm?: number;
  /**
   * Parte já gravada que a leitura nova contradiz (N1): aguarda o "é um novo" ou o
   * "é o mesmo, troca". Só grupo e posição; o nome vem do servidor a cada turno.
   */
  conflito?: { grupo: "compradores" | "vendedores"; posicao: number };
  /** A revisão do rascunho em curso (T11/T12). Ausente = não está revisando. */
  revisao?: RevisaoEmCurso;
  /**
   * Link da tela do rascunho, SÓ quando o servidor o deu (`documento.link` da gravação ou o
   * `link` de `edicao_pela_tela`/`documento_proprio`). O Max nunca o monta (§18.13.5).
   */
  linkDaTela?: string;
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
