/**
 * Formulários pelo WhatsApp (v2): FORMA do que o servidor (contractmaker) fala.
 *
 * Fonte única: `docs/max.md` do contractmaker, §18.13.1 a §18.13.12. Aqui só há
 * tipos: nenhum campo é inventado. O que o servidor não diz (ou diz como
 * opcional) fica opcional. Nada neste arquivo carrega CPF, e-mail ou telefone.
 */

/** Uma pendência do `faltando` (§18.13.2). Só posição, papel e caminho: nunca nome nem documento. */
export interface Pendencia {
  signatario: { posicao: number; papel: string } | null;
  /** Chave do catálogo (proposta) ou caminho (captação). Com `motivo: "minimo_de_testemunhas"`, vale `"testemunhas"`. */
  campo: string;
  motivo: "obrigatorio_da_org" | "obrigatorio_do_modelo" | "minimo_de_testemunhas" | (string & {});
  /** Só no `minimo_de_testemunhas` (§18.13.12.2). */
  minimo?: number;
  atual?: number;
}

export type TipoDeCampo = "texto" | "numero" | "moeda" | "data" | "cpf_cnpj" | "telefone" | "email" | "opcao";

/** Item de `proposal.options.obrigatorios` (§18.13.3). O `id` da opção é o valor GRAVADO, nunca o rótulo (L8). */
export interface CampoObrigatorio {
  chave: string;
  rotulo: string;
  /** Rótulo legível do grupo ("Negociação"), não o slug. */
  grupo: string;
  esteira: "venda" | "locacao" | "ambas";
  tipoCampo: TipoDeCampo;
  opcoes?: Array<{ id: string; rotulo: string }>;
}

export interface Modalidade {
  schemaType: string;
  esteira: "venda" | "locacao";
  rotulo: string;
  modeloDisponivel: boolean;
}

export type TipoDeAssinatura = "email" | "whatsapp" | "aceite";

/** `tiposDeAssinatura[]` (§18.13.3). Sem telefone, e-mail nem CPF. */
export interface OpcaoDeAssinatura {
  tipo: TipoDeAssinatura;
  disponivel: boolean;
  motivo?: string;
  saiComo?: "aceite";
  /** SÓ no Aceite disponível. Envelope nunca traz valor em reais. */
  custoCentavos?: number;
  custoPorDestinatario?: boolean;
  semLembrete?: boolean;
  assinantesSemCelular?: Array<{ posicao: number; papel: string; nome: string }>;
  texto: string;
}

/** `options.testemunhas` (§18.13.12.2). Sem CPF/e-mail/celular. */
export interface RegraDeTestemunhas {
  minimo: number;
  maximo: number;
  padrao: Array<{ idPadrao: string; nome: string; obrigatoria: boolean; podeAceite: boolean }>;
  linkConfiguracoes: string;
}

interface OptionsComum {
  metodos: Array<{ valor: string; rotulo: string }>;
  /** `{nome, papel, canal}` dos incluídos; `[]` sem alvo. */
  signatarios: Array<{ nome: string; papel: string; canal?: string }>;
  assinaturaConfigurada: boolean;
}

/** `proposal.options` com a flag do servidor DESLIGADA (ou servidor antigo, sem a chave). */
export interface OptionsV1 extends OptionsComum {
  fluxoV2?: false;
}

/**
 * `proposal.options` com a flag LIGADA. `testemunhas` é opcional no fio: sem
 * alvo e sem `tipo`/`schemaType` a esteira é indefinida e a chave não vai
 * (§18.13.12.2). `fluxoV2` é sempre a última chave.
 */
export interface OptionsV2 extends OptionsComum {
  modalidades: Modalidade[];
  obrigatorios: CampoObrigatorio[];
  tiposDeAssinatura: OpcaoDeAssinatura[];
  testemunhas?: RegraDeTestemunhas;
  /** SÓ com alvo. */
  faltando?: Pendencia[];
  fluxoV2: true;
}

/** Pessoa da proposta v2 (forma do `create`/`update`, §18.13.4). */
export interface ParteV2 {
  tipo_pessoa?: "fisica" | "juridica";
  nome?: string;
  cpf?: string;
  cnpj?: string;
  email?: string;
  telefone?: string;
  data_nascimento?: string;
  estado_civil?: string;
  regime_bens?: string;
  /** Só `true` (R38). */
  substituir?: true;
  conjuge?: { nome?: string; cpf?: string; substituir?: true };
  representante?: { nome?: string; cpf?: string; substituir?: true };
}

/** Argumentos do `proposal.create` / `proposal.update` v2. Sem `canal` no create (D4). */
export interface PatchV2 {
  schemaType?: string;
  tipo?: "venda" | "locacao";
  compradores?: ParteV2[];
  vendedores?: ParteV2[];
  imovel?: Record<string, unknown>;
  negociacao?: {
    valor?: number;
    sinal?: number;
    modalidade?: string;
    prazo_meses?: number;
    data_entrada?: string;
  };
  corretor?: { nome?: string; creci?: string; mobile_phone?: string; email?: string };
  observacoes?: string;
  tipo_assinatura?: TipoDeAssinatura;
  excecoes_canal?: Array<{ posicao: number; papel: string; canal: string }>;
  regerar_documento?: boolean;
}
