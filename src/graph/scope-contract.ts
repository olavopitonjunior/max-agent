/**
 * O contrato do `POST /api/agents/scope-query` do ImobPro — a metade daqui.
 *
 * **Sem consumidor, de propósito.** A regra 2 da governança do Max
 * (`contractmaker/CLAUDE.md`) manda o receptor entrar antes, inerte: o cliente
 * de verdade (`src/lib/scope.ts`) e o nó `tools` que o usa são o PR 6. O que
 * este arquivo entrega hoje é o TIPO e o VETOR, para que a divergência de
 * contrato apareça em teste vermelho no dia em que ela nascer, e não meses
 * depois numa conversa errada.
 *
 * ── Por que este contrato precisa de vetor tanto quanto o do HMAC ─────────
 *
 * O modo de falha do HMAC é barulhento: 401 em toda chamada, e alguém percebe.
 * O deste é **silencioso e assimétrico**, e pior que o da política: se o ImobPro
 * renomear `referencia` para `ref`, este lado lê `undefined` e o Max passa a
 * falar de "negócio undefined" — feio, mas visível. Se o ImobPro **acrescentar**
 * um campo à projeção do broker, nada aqui quebra e o vazamento entra em
 * produção sem uma linha vermelha em lugar nenhum.
 *
 * Por isso o vetor do broker abaixo é afirmado por **AUSÊNCIA** também deste
 * lado: são duas chaves iguais em dois cofres, e a leitura de um não substitui
 * a do outro.
 *
 * O literal é literal de propósito, e não montado a partir dos tipos: um
 * fixture derivado do próprio código acompanharia a renomeação em silêncio, que
 * é o defeito que ele deveria pegar.
 */

/** O sujeito da leitura. O corretor comissionado NÃO é `User`. */
export type ScopeSubject =
  | { kind: "user"; userId: string }
  | { kind: "broker"; splitRecipientId: string };

/** Os verbos de leitura. Espelha `VERBOS_DE_LEITURA` do ImobPro. */
export const VERBOS_DE_LEITURA = [
  "deal.list",
  "deal.detail",
  "deal.pending",
  "proposal.list",
  "proposal.detail",
] as const;

export type ScopeQueryVerb = (typeof VERBOS_DE_LEITURA)[number];

export interface ScopeQueryRequest {
  verb: ScopeQueryVerb;
  subject: ScopeSubject;
  /**
   * Obrigatório, e VALIDA o `subject`: o servidor refaz o vínculo
   * telefone→sujeito. Divergência é 403, não lista vazia.
   */
  phone: string;
  args?: {
    estado?: string;
    limite?: number;
    negocio_id?: string;
    proposta_id?: string;
  };
}

/** O que o USUÁRIO da plataforma recebe. */
export interface DealProjetadoUser {
  id: string;
  etapa: string | null;
  pendencias: string[];
  atualizadoEm: string;
  titulo: string;
  cliente: string | null;
  valor: number | null;
}

/**
 * O que o CORRETOR COMISSIONADO recebe — menos campos, mesmo verbo.
 *
 * Sem `titulo` (carrega endereço), sem `cliente`, sem `valor`. `referencia`
 * existe porque ele precisa dizer DE QUAL negócio fala sem que a plataforma lhe
 * entregue o endereço.
 */
export interface DealProjetadoBroker {
  id: string;
  etapa: string | null;
  pendencias: string[];
  atualizadoEm: string;
  referencia: string;
}

/** Campos que a projeção do broker NUNCA pode conter. Ver o teste de paridade. */
export const CAMPOS_PROIBIDOS_AO_BROKER = [
  "titulo",
  "cliente",
  "valor",
  "clientName",
  "title",
  "value",
  "email",
  "telefone",
  "phone",
  "cpf",
  "cpfCnpj",
  "dataJson",
] as const;

export interface ScopeQueryResponse<T> {
  items: T[];
  truncated?: boolean;
}
