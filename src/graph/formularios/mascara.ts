/**
 * A máscara de dado pessoal para o que o corretor VÊ na conversa: a ficha ✅/⬜ e a
 * conferência "lido — confira". Saiu de `ficha.ts` (16/11, F2, decisão do Olavo: a
 * conferência mascara como a ficha) para `midia.ts` usar a mesma regra sem import
 * circular. CPF `***.456.789-**`, CNPJ, e-mail e telefone: pelo NOME do campo e, em
 * texto livre, pelo FORMATO.
 */

import { RE_CNPJ, RE_CPF } from "@/lib/pii";

function ultimoSegmento(path: string): string {
  return path.split(".").pop() ?? path;
}

function soDigitos(s: string): string {
  return s.replace(/\D/g, "");
}

function mascararCpf(d: string): string {
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

function mascararCnpj(d: string): string {
  return `**.***.***/${d.slice(8, 12)}-**`;
}

function mascararEmail(v: string): string {
  const [local, dominio] = v.trim().split("@");
  if (!local || !dominio) return "***";
  return `${local[0]}***@${dominio}`;
}

function mascararTelefone(v: string): string {
  const d = soDigitos(v);
  if (d.length < 10) return "*****";
  const ddd = d.length >= 11 ? d.slice(-11, -9) : d.slice(-10, -8);
  return `(${ddd}) *****-${d.slice(-4)}`;
}

/** Uma linha, sem sinal de confirmação forjado (um valor lido não pode fingir "tudo certo"), curta. */
function linhaLimpa(v: string): string {
  return v
    .replace(/[✅✔☑⬜📄]️?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * O valor como o corretor pode vê-lo na ficha. Pelo NOME do campo (cpf, cnpj, e-mail,
 * telefone) e, em texto livre, pelo FORMATO: um CPF no meio da observação também sai
 * mascarado.
 */
export function mascararValor(path: string, valor: string): string {
  const campo = ultimoSegmento(path);
  const d = soDigitos(valor);
  if (campo === "cpf" && d.length === 11) return mascararCpf(d);
  if (campo === "cnpj" && d.length === 14) return mascararCnpj(d);
  if (campo === "documento") {
    if (d.length === 11) return mascararCpf(d);
    if (d.length === 14) return mascararCnpj(d);
  }
  if (campo === "email" && valor.includes("@")) return mascararEmail(valor);
  if (["telefone", "telefone1", "telefone2", "mobile_phone", "celular"].includes(campo)) return mascararTelefone(valor);
  const semDocumentos = valor
    .replace(RE_CNPJ, (m) => mascararCnpj(soDigitos(m)))
    .replace(RE_CPF, (m) => mascararCpf(soDigitos(m)))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => mascararEmail(m));
  return linhaLimpa(semDocumentos);
}
