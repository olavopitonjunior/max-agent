/**
 * Dados FICTÍCIOS dos evals dos formulários v2 (Tarefa 18).
 *
 * Nenhuma conversa real entra aqui em claro: os nomes são inventados, os CPFs vêm de um gerador com
 * dígito verificador válido (ou do sintético `529.982.247-25` que o repositório já usa), os telefones
 * são `+55 11 90000-00xx` e os e-mails usam o domínio reservado `.invalid`.
 */

/** O CPF sintético fixo dos testes do repositório (`529.982.247-25`). */
export const CPF_SINTETICO = "52998224725";

/** CPF fictício com os dois dígitos verificadores corretos. `n` (0..999) escolhe o miolo. */
export function cpfFicticio(n: number): string {
  const base = String(100_000_000 + ((n * 7_919) % 899_999_999))
    .slice(0, 9)
    .split("")
    .map(Number);
  const dv = (digs: number[]): number => {
    const soma = digs.reduce((acc, d, i) => acc + d * (digs.length + 1 - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join("");
}

export function formatarCpf(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

/** Telefone fictício `+55 11 90000-00xx` (xx de 00 a 99). */
export function telefoneFicticio(n: number): string {
  return `+55 11 90000-00${String(n % 100).padStart(2, "0")}`;
}

/** Só os dígitos do telefone sem o `+55` (o que o servidor grava). */
export function telefoneSoDigitos(n: number): string {
  return `119000000${String(n % 100).padStart(2, "0")}`.slice(-11);
}

/** Pessoas inventadas, uma por papel, usadas pelas conversas mascaradas. */
export const PESSOAS = {
  comprador: "Rodrigo Teixeira Lima",
  compradora2: "Beatriz Souza Andrade",
  vendedora: "Helena Duarte Campos",
  vendedor: "Otavio Brandao Reis",
  corretora: "Marcia",
} as const;

/** E-mail fictício (domínio reservado `.invalid`). */
export const emailFicticio = (quem: string): string => `${quem.toLowerCase().replace(/[^a-z]/g, ".")}@exemplo.invalid`;
