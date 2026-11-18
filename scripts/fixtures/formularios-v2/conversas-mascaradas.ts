/**
 * Conversas MASCARADAS dos evals dos formulários v2 (Tarefa 18).
 *
 * Cada conversa é adaptada de um caso real do golden set (`origin/feat/golden-set:evals/golden/casos.ts`) ou
 * da spec de 06/11 (Newton que dizia "anotado" sem gravar). A máscara troca TUDO que identifica: nomes
 * inventados, CPF com dígito verificador válido de `mascara.ts`, telefones `+55 11 90000-00xx` e e-mails
 * `.invalid`. O texto do corretor é preservado no jeito de falar (abreviações, tudo numa linha).
 *
 * O fixture descreve também o que o MODELO de extração devolve em cada turno (`extracao`), com
 * placeholders `{{CPF:n}}` no lugar dos tokens: o harness troca pelo token que o prompt realmente trouxe.
 * Em produção o modelo é quem lê o texto; aqui o resultado dele é dado fixo, para o eval ser determinístico.
 */
import { CPF_SINTETICO, PESSOAS, cpfFicticio, emailFicticio, formatarCpf, telefoneFicticio, telefoneSoDigitos } from "./mascara";

export type PatchDoFixture = Record<string, unknown>;

export interface EsperaDoTurno {
  /** Trechos que a resposta TEM de conter (string = trecho literal). */
  contem?: Array<string | RegExp>;
  /** Trechos que a resposta NÃO pode conter. */
  naoContem?: Array<string | RegExp>;
  /** O turno não responde (a ficha sai depois da pausa, pelo outbox) e o corretor só vê a reação. */
  silencioso?: boolean;
  /** Verbos de escrita esperados NESTE turno, com o status devolvido pelo servidor falso (em ordem). */
  grava?: Array<[verbo: string, status: number]>;
  /** A ficha agendada no outbox neste turno tem de conter estes trechos. */
  fichaAgendadaContem?: Array<string | RegExp>;
}

export interface TurnoDoFixture {
  /** O que o corretor escreve. */
  corretor: string;
  /** O que o modelo de EXTRAÇÃO devolve neste turno. Ausente = o turno não passa pela extração. */
  extracao?: PatchDoFixture;
  /** O corretor pede uma criação em linguagem natural e o modelo de CONVERSA chama `propor_criacao`. */
  abreFluxo?: { tipo: "proposta" | "venda" | "locacao"; natureza?: "venda" | "locacao" };
  espera?: EsperaDoTurno;
}

export interface RascunhoInicial {
  codigo: string;
  id: string;
  comprador: { nome: string };
  valor: number;
}

export interface RascunhoFinalEsperado {
  compradores?: Array<Record<string, unknown>>;
  vendedores?: Array<Record<string, unknown>>;
  imovel?: Record<string, unknown>;
  negociacao?: Record<string, unknown>;
}

export interface ConversaMascarada {
  id: string;
  /** De onde a conversa foi adaptada (id do caso do golden set ou da spec). */
  origem: string;
  bot: "max" | "newton";
  /** Textos fictícios que NUNCA podem chegar ao modelo fora das cercas (nome) ou em claro (CPF). */
  nomes: string[];
  cpfs: string[];
  /** A org exige CPF/CNPJ do proponente (obrigatório `proponente.documento`). */
  exigeDocumento?: boolean;
  /** O fluxo já abre semeado (equivale ao corretor ter pedido a proposta antes). */
  semeado: boolean;
  /** Proposta que já existe no servidor (conversas de envio). */
  rascunhoInicial?: RascunhoInicial;
  turnos: TurnoDoFixture[];
  rascunhoFinal?: RascunhoFinalEsperado;
}

const CPF_COMPRADOR = cpfFicticio(11);
const CPF_VENDEDORA = cpfFicticio(23);
const FONE_COMPRADOR = telefoneFicticio(21);
const FONE_VENDEDORA = telefoneFicticio(22);

// ─── 1. M4': proposta de compra pedida em partes (Max) ───────────────────────────────────────────

const M4: ConversaMascarada = {
  id: "m4-proposta-compra-em-partes",
  origem: "golden M4' — compra pedida em partes: 'casado' não pode ser descartado, o CPF aparece no que falta e só o SIM grava",
  bot: "max",
  nomes: [PESSOAS.comprador],
  cpfs: [CPF_COMPRADOR],
  exigeDocumento: true,
  semeado: true,
  turnos: [
    {
      corretor:
        `Quero fazer uma proposta de compra: comprador ${PESSOAS.comprador}, casado, tel ${FONE_COMPRADOR}, ` +
        "imóvel Apto 42 Rua das Acácias 30, São Paulo/SP, R$ 500.000 à vista",
      extracao: {
        compradores: [{ nome: PESSOAS.comprador, estado_civil: "casado", telefone: "{{TEL:1}}" }],
        imovel: { endereco: "Rua das Acácias", numero: "30", complemento: "Apto 42", cidade: "São Paulo", uf: "SP" },
        negociacao: { valor: 500000, modalidade: "à vista" },
      },
      // Falta o CPF (obrigatório da org): a ficha espera a pausa e sai agendada, sem dizer que anotou.
      espera: { silencioso: true, fichaAgendadaContem: ["CPF ou CNPJ", "casado"] },
    },
    {
      corretor: `o CPF dele é ${formatarCpf(CPF_COMPRADOR)}`,
      extracao: { compradores: [{ cpf: "{{CPF:1}}" }] },
      // Agora o rascunho está completo: a ficha sai na hora, com o CPF mascarado e o "casado" preservado.
      espera: { contem: ["Rodrigo Teixeira Lima", "casado", /responda SIM/i, "***."], naoContem: [CPF_COMPRADOR, formatarCpf(CPF_COMPRADOR)] },
    },
    { corretor: "sim", espera: { grava: [["proposal.create", 201]], contem: [/anotei e salvei/i], naoContem: [/enviad/i] } },
  ],
  rascunhoFinal: {
    compradores: [{ nome: PESSOAS.comprador, cpf: CPF_COMPRADOR, estado_civil: "casado" }],
    imovel: { endereco: "Rua das Acácias", numero: "30", complemento: "Apto 42", cidade: "São Paulo", uf: "SP" },
    negociacao: { valor: 500000 },
  },
};

// ─── 2. W46: complemento na revisão (Max) ────────────────────────────────────────────────────────

const W46: ConversaMascarada = {
  id: "w46-complemento-na-revisao",
  origem: "golden W46 — 'o complemento é apartamento 1' na revisão: o resumo tem de voltar atualizado, não só dizer 'ajusto'",
  bot: "max",
  nomes: [PESSOAS.compradora2],
  cpfs: [],
  semeado: false,
  turnos: [
    {
      corretor: "Quero criar uma proposta de venda",
      abreFluxo: { tipo: "proposta", natureza: "venda" },
      espera: { contem: [/vamos montar a proposta/i], naoContem: [/\*\*/] },
    },
    {
      corretor: `Comprador: ${PESSOAS.compradora2}; telefone ${FONE_COMPRADOR}; imóvel Rua de Teste QA, 100, São Paulo/SP; valor R$ 500.000,00 à vista.`,
      extracao: {
        compradores: [{ nome: PESSOAS.compradora2, telefone: "{{TEL:1}}" }],
        imovel: { endereco: "Rua de Teste QA", numero: "100", cidade: "São Paulo", uf: "SP" },
        negociacao: { valor: 500000 },
      },
      espera: { contem: [PESSOAS.compradora2, /responda SIM/i] },
    },
    {
      corretor: "o complemento é apartamento 1",
      extracao: { imovel: { complemento: "apartamento 1" } },
      espera: { contem: ["apartamento 1", /SIM/], naoContem: [/\bajusto\b/i, /vou ajustar/i], grava: [] },
    },
    { corretor: "sim", espera: { grava: [["proposal.create", 201]], contem: [/anotei e salvei/i] } },
  ],
  rascunhoFinal: {
    compradores: [{ nome: PESSOAS.compradora2 }],
    imovel: { endereco: "Rua de Teste QA", numero: "100", complemento: "apartamento 1", cidade: "São Paulo", uf: "SP" },
    negociacao: { valor: 500000 },
  },
};

// ─── 3. M6b: enviar proposta por código (Max) ────────────────────────────────────────────────────

const M6B: ConversaMascarada = {
  id: "m6b-enviar-proposta-por-codigo",
  origem: "golden M6b — 'manda a PROP-2026-0003 pro comprador assinar': sem 'celular ou link', sem vocativo de cliente",
  bot: "max",
  nomes: [PESSOAS.comprador],
  cpfs: [],
  semeado: false,
  rascunhoInicial: { codigo: "PROP-2026-0003", id: "prop-3", comprador: { nome: PESSOAS.comprador }, valor: 350000 },
  turnos: [
    {
      corretor: "manda a PROP-2026-0003 pro comprador assinar",
      espera: { contem: ["0003", /Como enviar para assinatura\?/], naoContem: [/celular ou (o )?link/i, `Pronto, ${PESSOAS.comprador}`], grava: [] },
    },
    { corretor: "e-mail", espera: { contem: [/Antes de enviar, confira/, /Responda \*SIM\*/], grava: [] } },
    { corretor: "sim", espera: { grava: [["proposal.send", 200]], contem: [/enviada para assinatura/i] } },
  ],
};

// ─── 4. R3: tipos de assinatura (Newton) ─────────────────────────────────────────────────────────

const R3_NEWTON: ConversaMascarada = {
  id: "r3-newton-tipos-de-assinatura",
  origem: "golden R3 — o Newton respondia 'foge do que eu faço' sobre os tipos de assinatura; aqui a lista sai numerada, em texto, com o Aceite",
  bot: "newton",
  nomes: [PESSOAS.vendedor],
  cpfs: [],
  semeado: false,
  rascunhoInicial: { codigo: "PROP-2026-0007", id: "prop-7", comprador: { nome: PESSOAS.vendedor }, valor: 420000 },
  turnos: [
    {
      corretor: "manda a PROP-2026-0007 para assinar",
      espera: { contem: [/^1\. /m, /^2\. /m, /^3\. /m, "Aceite no celular"], naoContem: [/foge do que eu fa[çc]o/i, /\*\*/], grava: [] },
    },
    {
      corretor: "3",
      espera: { contem: [/Aceite/, /Responda \*SIM\* para gravar/], grava: [] },
    },
    { corretor: "sim", espera: { grava: [["proposal.update", 200]], contem: [/Antes de enviar, confira/, /Instrumento: aceite/i] } },
    { corretor: "sim", espera: { grava: [["proposal.send", 200]] } },
  ],
};

// ─── 5. Newton: proposta pedida em várias mensagens curtas ───────────────────────────────────────

const NEWTON_EM_PARTES: ConversaMascarada = {
  id: "newton-proposta-em-partes",
  origem: "conversa real do Newton (RE/MAX), mascarada: o corretor manda nome, CPF e valor em mensagens curtas, em texto puro",
  bot: "newton",
  nomes: [PESSOAS.compradora2],
  cpfs: [CPF_SINTETICO],
  semeado: true,
  turnos: [
    { corretor: `compradora ${PESSOAS.compradora2}`, extracao: { compradores: [{ nome: PESSOAS.compradora2 }] }, espera: { silencioso: true } },
    { corretor: "cpf 529.982.247-25", extracao: { compradores: [{ cpf: "{{CPF:1}}" }] }, espera: { silencioso: true, fichaAgendadaContem: ["Valor da proposta"] } },
    {
      corretor: "valor R$ 650.000",
      extracao: { negociacao: { valor: 650000 } },
      espera: { contem: [PESSOAS.compradora2, "***.982.247-**", /responda SIM/i], naoContem: ["529.982.247-25", /\*\*[A-Za-z]/] },
    },
    { corretor: "sim", espera: { grava: [["proposal.create", 201]], contem: [/anotei e salvei/i] } },
  ],
  rascunhoFinal: { compradores: [{ nome: PESSOAS.compradora2, cpf: CPF_SINTETICO }], negociacao: { valor: 650000 } },
};

export const CONVERSAS_MASCARADAS: ConversaMascarada[] = [M4, W46, M6B, R3_NEWTON, NEWTON_EM_PARTES];

// ─── 6. O caso do Newton de 06/11 ────────────────────────────────────────────────────────────────

/**
 * O que motivou a spec (memória `max-newton-formularios-whatsapp-redesign`): o Newton recebia os dados da
 * proposta e dizia "anotado" SEM gravar; o extrator não tinha contexto das mensagens anteriores; e o
 * playground de 06/11 achou ainda "casado" descartado, e-mail da vendedora caindo no comprador, correção de
 * nome apagando CPF e telefone. A conversa abaixo junta exatamente esses furos. O texto original não foi
 * preservado em lugar nenhum do repositório: o conteúdo é reconstruído da descrição, com dados inventados.
 */
export const NEWTON_0611: ConversaMascarada = {
  id: "newton-0611-anotado-sem-gravar",
  origem: "spec 06/11 — caso real do Newton que dizia 'anotado' sem gravar (texto original não preservado; reconstruído da descrição)",
  bot: "newton",
  nomes: [PESSOAS.comprador, `${PESSOAS.comprador} Junior`, PESSOAS.vendedora],
  cpfs: [CPF_COMPRADOR],
  semeado: true,
  turnos: [
    {
      corretor: `Proposta de venda. Comprador ${PESSOAS.comprador}, casado, CPF ${formatarCpf(CPF_COMPRADOR)}, tel ${FONE_COMPRADOR}`,
      extracao: {
        compradores: [{ nome: PESSOAS.comprador, estado_civil: "casado", cpf: "{{CPF:1}}", telefone: "{{TEL:1}}" }],
      },
      espera: { silencioso: true },
    },
    {
      corretor: `vendedora ${PESSOAS.vendedora}, email ${emailFicticio("helena duarte")}, tel ${FONE_VENDEDORA}`,
      extracao: {
        vendedores: [{ nome: PESSOAS.vendedora, email: "{{EMAIL:1}}", telefone: "{{TEL:2}}" }],
      },
      espera: { silencioso: true },
    },
    {
      corretor: "valor 800 mil à vista",
      extracao: { negociacao: { valor: 800000, modalidade: "à vista" } },
      espera: { contem: [PESSOAS.comprador, PESSOAS.vendedora, /responda SIM/i], naoContem: [formatarCpf(CPF_COMPRADOR), CPF_COMPRADOR] },
    },
    {
      corretor: `o nome do comprador é ${PESSOAS.comprador} Junior`,
      extracao: { compradores: [{ nome: `${PESSOAS.comprador} Junior` }] },
      espera: { contem: [`${PESSOAS.comprador} Junior`, /responda SIM/i], grava: [] },
    },
    { corretor: "sim", espera: { grava: [["proposal.create", 201]], contem: [/anotei e salvei/i] } },
  ],
  rascunhoFinal: {
    // O telefone e o CPF sobrevivem à correção de nome; o e-mail fica na VENDEDORA, nunca no comprador.
    compradores: [{ nome: `${PESSOAS.comprador} Junior`, cpf: CPF_COMPRADOR, estado_civil: "casado" }],
    vendedores: [{ nome: PESSOAS.vendedora, email: emailFicticio("helena duarte") }],
    negociacao: { valor: 800000 },
  },
};

/** Os telefones esperados no rascunho (só dígitos), para as conversas que os conferem. */
export const TELEFONES = {
  comprador: telefoneSoDigitos(21),
  vendedora: telefoneSoDigitos(22),
};

export { CPF_COMPRADOR, CPF_VENDEDORA, FONE_COMPRADOR, FONE_VENDEDORA };
