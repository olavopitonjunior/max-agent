import { maskPhone } from "./phone";

/**
 * Texto de ERRO que sai pelas rotas de admin (`last_error`, `error`) passa por
 * aqui. Erro vem do provedor ou do nosso wrapper de fetch e carrega o que
 * estava na mão na hora: o destinatário e, na Z-API, a URL com a credencial
 * no caminho (`/instances/<id>/token/<token>/send-text`). As falhas de 10–15/09
 * ficaram gravadas assim e apareciam na Mission Control.
 *
 * Só erro. O texto da CONVERSA fica como está: é o conteúdo que o painel
 * existe para mostrar.
 */
export function erroSemSegredo(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  return semTelefone(semCredencial(texto));
}

/** Separador de caminho: `/`, `\/` ou `\\/` (JSON citado, uma ou duas vezes) ou `%2F`. */
const SEP = String.raw`(?:\\*\/|%2F)`;
const SEGMENTO = new RegExp(
  // Sem separador antes, só `instances` (início de URL cortada): `token/` solto
  // casaria "invalid token/expired".
  String.raw`(${SEP}|\b(?=instances))(instances|token|client-token)${SEP}[^/\\\s"'?#%&]+`,
  "gi"
);
// Sem `\` no valor: dentro de JSON citado, engolir a barra quebra o JSON.
const PARAMETRO = /([?&](?:access_token|appsecret_proof|token|client_token|client-token)=)[^&\s"'#\\]+/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Credenciais das envs: rede extra para formatos que as regex não preveem. */
const ENVS_SECRETAS = [
  "ZAPI_INSTANCE_ID",
  "ZAPI_INSTANCE_TOKEN",
  "ZAPI_CLIENT_TOKEN",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
  "ZAPI_WEBHOOK_SECRET",
  "MAX_NOTIFY_SECRET",
  "MAX_WEBHOOK_SECRET",
  "MAX_ENCRYPTION_KEY",
  "OPENROUTER_API_KEY",
  "CRON_SECRET",
];

/** Segmento de caminho, parâmetro ou cabeçalho que é credencial vira `***`. */
export function semCredencial(texto: string): string {
  let t = texto
    .replace(SEGMENTO, (m: string, antes: string, nome: string) =>
      `${antes}${nome}${m.slice(antes.length + nome.length).match(/^(?:\\*\/|%2F)/i)?.[0] ?? "/"}***`)
    .replace(PARAMETRO, "$1***")
    .replace(BEARER, "$1 ***");
  for (const nome of ENVS_SECRETAS) {
    const valor = process.env[nome]?.trim();
    // Curto demais casaria texto comum; credencial real tem dezenas de chars.
    if (valor && valor.length >= 12) t = t.split(valor).join("***");
  }
  return t;
}

/**
 * Dígitos com separadores no meio: provedor formata ("55 11 98765-0003",
 * "(11) 98765-0003"). Casa o trecho largo e só mascara se, sem os
 * separadores, tiver cara de telefone (10 a 13 dígitos). Data com hora
 * ("2026-10-05 12:34:56", o `timestamptz::text` do Postgres) também soma 10+
 * dígitos e não é telefone.
 */
export function semTelefone(texto: string): string {
  return texto.replace(/\+?\(?\d[\d\s().-]{8,20}\d/g, (m) => {
    if (/^\d{4}-\d\d-\d\d/.test(m)) return m;
    const digitos = m.replace(/\D/g, "");
    return digitos.length >= 10 && digitos.length <= 13 ? maskPhone(digitos) : m;
  });
}

/**
 * Objeto de diagnóstico do provedor (`connectionStatus`): toda folha string
 * passa por `semCredencial`, sem serializar. Redigir o JSON inteiro como texto
 * arriscava engolir um escape e devolver JSON inválido (500 na tela que se
 * abre justamente quando o provedor está com problema).
 */
export function folhasSemCredencial<T>(valor: T): T {
  if (typeof valor === "string") return semCredencial(valor) as T;
  if (Array.isArray(valor)) return valor.map(folhasSemCredencial) as T;
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, folhasSemCredencial(v)])
    ) as T;
  }
  return valor;
}
