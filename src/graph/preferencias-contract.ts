/**
 * O contrato do `/api/agents/notification-preferences` do ImobPro (task P8) — a
 * metade daqui. Só tipos: o cliente (`src/lib/cm.ts`) e o fluxo
 * (`preferencias.ts`) partilham este arquivo para que a divergência apareça no
 * typecheck, e não numa conversa errada.
 *
 * A rota fala da PRÓPRIA pessoa, identificada pelo telefone (Bearer da org +
 * `phone`); não existe parâmetro que aponte para outro usuário.
 */

/**
 * Apelidos que o modelo usa para os três tipos de aviso conhecidos, e o tipo do
 * servidor a que cada um aponta. A tool também aceita o tipo cru e o nome legível
 * que vêm no GET; o servidor continua sendo quem decide o que existe.
 */
export const ALIAS_DE_TIPO_DE_AVISO: Readonly<Record<string, string>> = {
  relatorio_manha: "activity_due",
  lembrete_vencimento: "activity_due_soon",
  conclusao_atividade: "activity_completed",
};

/** Canais de um tipo de aviso. Ausente = não tocar. */
export interface CanaisDoAviso {
  email?: boolean;
  whatsapp?: boolean;
}

/** O que está gravado para a pessoa. Tipo ausente = vale o padrão do sistema. */
export interface PrefsDaPessoa {
  types?: Record<string, CanaisDoAviso>;
  events?: Record<string, CanaisDoAviso>;
  schedule?: { morningReportAt?: string; dueSoonLeadMin?: number };
}

/** `GET ?phone=` */
export interface PrefsView {
  prefs: PrefsDaPessoa;
  defaults: { morningReportAt: string; dueSoonLeadMin: number };
  /** Os únicos valores que o servidor aceita. O motor valida contra isto antes de propor. */
  options: { morningReport: string[]; dueSoon: number[] };
  /** Os tipos de aviso que a pessoa pode ajustar, com o nome legível. */
  tipos: { type: string; label: string }[];
}

/** O corpo do PATCH (`{ phone, patch }`). Valores absolutos: repetir o PATCH é seguro. */
export interface PrefsPatch {
  types?: Record<string, CanaisDoAviso>;
  events?: Record<string, CanaisDoAviso>;
  schedule?: { morningReportAt?: string; dueSoonLeadMin?: number };
}

/** Os códigos de recusa que o contrato do servidor define. */
export const CODIGOS_DE_RECUSA_DE_PREFS = ["valor_invalido", "tipo_desconhecido", "sem_telefone", "email_nao_configuravel"] as const;

/**
 * `recusa_desconhecida` é do CLIENTE: o servidor mandou um `code` que o contrato não
 * conhece (versão nova da rota, por exemplo). Vira recusa genérica, nunca texto indefinido.
 */
export type CodigoDeRecusaDePrefs = (typeof CODIGOS_DE_RECUSA_DE_PREFS)[number] | "recusa_desconhecida";

/** 200 → `ok: true`; 422 → `ok: false`. Não compare o erro com `toEqual` estrito: `subject` pode vir. */
export type PrefsPatchResult =
  | { ok: true; prefs: PrefsDaPessoa; whatsappOptIn: "set" | "cleared" | "unchanged" }
  | { ok: false; code: CodigoDeRecusaDePrefs; allowed?: (string | number)[]; subject?: string };
