/**
 * A extração do v2 (T4 → condutor): o que o modelo devolve da janela de mensagens
 * vira CAMPO LIDO pendente de confirmação, nunca gravação.
 *
 * O modelo só PREENCHE; quem decide é o código. Cada valor volta ao texto que o
 * corretor escreveu antes de valer (mesma disciplina do `conferirDitado` do v1):
 *
 *  - CPF/CNPJ: dígito verificador válido E os dígitos existem no texto;
 *  - telefone/e-mail: existem no texto;
 *  - nome: cada palavra relevante existe no texto;
 *  - valor/sinal: o número está entre os valores que o texto cita;
 *  - chave que não está na lista fechada é ignorada (nunca vira campo).
 *
 * Os caminhos são os canônicos do servidor (`compradores[0].cpf`, `imovel.cidade`,
 * `negociacao.valor`), os mesmos que o cofre dos lidos de documento usa: o card
 * "Entendi assim — confira" e a gravação por "sim" são um caminho só.
 *
 * Puro (sem rede).
 */

import { cnpjValido } from "../captacao";
import { cpfValido, valoresNoTexto } from "../credito";
import type { CampoLido } from "./midia";

const PESSOA_PROPS = {
  nome: { type: "string", description: "Nome completo, como o corretor escreveu." },
  cpf: { type: "string" },
  cnpj: { type: "string" },
  email: { type: "string" },
  telefone: { type: "string", description: "Com DDD." },
  data_nascimento: { type: "string", description: "AAAA-MM-DD." },
  estado_civil: { type: "string" },
} as const;

const PESSOA = { type: "object", properties: PESSOA_PROPS, additionalProperties: false } as const;

const NUMERO_OU_TOKEN = {
  anyOf: [{ type: "number" }, { type: "string", pattern: "^⟨VALOR_[0-9]+⟩$" }],
  description: "Se houver token ⟨VALOR_N⟩, copie o token literalmente como string. Caso contrário, informe número.",
} as const;

/** A tool do v2. Sempre a mesma (`toolChoice` fixo): o que o texto diz não escolhe ferramenta. */
export const TOOL_PATCH_V2 = {
  name: "preencher_proposta_v2",
  description:
    "Registra os dados de proposta que o corretor informou nas mensagens. Preencha só o que ele disse; " +
    "omita o resto. Nunca invente. Compradores/inquilinos em `compradores`, proprietários em `vendedores`, " +
    "na ordem em que aparecem. Números como número ('200 mil' → 200000).",
  parameters: {
    type: "object",
    properties: {
      compradores: { type: "array", items: PESSOA, description: "Quem compra ou aluga, na ordem." },
      vendedores: { type: "array", items: PESSOA, description: "Quem vende ou aluga o imóvel, na ordem." },
      imovel: {
        type: "object",
        properties: {
          matricula: { type: "string" },
          cartorio: { type: "string" },
          endereco: { type: "string" },
          numero: { type: "string" },
          complemento: { type: "string" },
          bairro: { type: "string" },
          cidade: { type: "string" },
          uf: { type: "string" },
          cep: { type: "string" },
          inscricao: { type: "string" },
        },
        additionalProperties: false,
      },
      negociacao: {
        type: "object",
        properties: {
          valor: { ...NUMERO_OU_TOKEN, description: "Venda: valor total. Locação: aluguel mensal. " + NUMERO_OU_TOKEN.description },
          sinal: NUMERO_OU_TOKEN,
          prazo_meses: { type: "number" },
          modalidade: { type: "string", description: "a_vista, financiamento, parcelado..." },
          data_entrada: { type: "string", description: "AAAA-MM-DD." },
        },
        additionalProperties: false,
      },
      corretor: {
        type: "object",
        properties: { creci: { type: "string" } },
        additionalProperties: false,
      },
      observacoes: { type: "string", description: "Condições combinadas que não cabem nos outros campos." },
    },
    additionalProperties: false,
  },
} as const;

const so = (s: string): string => s.replace(/\D/g, "");

const sem = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9@.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function umaLinha(v: string, max = 200): string {
  return v
    .replace(/[✅✔☑⬜📄]️?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const CAMPOS_DA_PESSOA = new Set(Object.keys(PESSOA_PROPS));
const CAMPOS_DO_IMOVEL = new Set(["matricula", "cartorio", "endereco", "numero", "complemento", "bairro", "cidade", "uf", "cep", "inscricao"]);
const CAMPOS_DA_NEGOCIACAO = new Set(["valor", "sinal", "prazo_meses", "modalidade", "data_entrada"]);
const MAX_PARTES = 4;

type Bruto = Record<string, unknown>;
const ehObjeto = (v: unknown): v is Bruto => !!v && typeof v === "object" && !Array.isArray(v);
const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** O valor em reais: número direto, ou texto ("500 mil") lido pelo mesmo parser do crédito. */
function valorEmReais(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const t = texto(v);
  if (!t) return null;
  const n = valoresNoTexto(t)[0];
  return n !== undefined && n > 0 ? n : null;
}

/**
 * Do que o modelo devolveu para os campos pendentes. `textoCru` é tudo que o
 * corretor escreveu na janela (mensagens + legendas + texto lido de documento).
 */
export function camposDoPatchExtraido(args: unknown, textoCru: string): CampoLido[] {
  if (!ehObjeto(args)) return [];
  const digitosDoTexto = so(textoCru);
  const norm = sem(textoCru);
  const valoresCitados = valoresNoTexto(textoCru);
  const out: CampoLido[] = [];
  const poe = (path: string, valor: string, confianca = 0.9): void => {
    out.push({ path, valor, confianca });
  };

  const validar = (campo: string, bruto: unknown): string | null => {
    const v = texto(bruto);
    if (!v) return null;
    switch (campo) {
      case "cpf":
        return cpfValido(v) && digitosDoTexto.includes(so(v)) ? so(v) : null;
      case "cnpj":
        return cnpjValido(v) && digitosDoTexto.includes(so(v)) ? so(v) : null;
      case "telefone": {
        const d = so(v).replace(/^55(?=\d{10,11}$)/, "");
        return d.length >= 10 && digitosDoTexto.includes(d) ? d : null;
      }
      case "email":
        return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) && norm.includes(v.toLowerCase()) ? v.toLowerCase() : null;
      case "nome": {
        const palavras = sem(v).split(" ").filter((p) => p.length > 2);
        return palavras.length > 0 && palavras.every((p) => norm.includes(p)) ? umaLinha(v, 120) : null;
      }
      case "data_nascimento":
      case "data_entrada":
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      default:
        return umaLinha(v, 120) || null;
    }
  };

  for (const lista of ["compradores", "vendedores"] as const) {
    const partes = args[lista];
    if (!Array.isArray(partes)) continue;
    partes.slice(0, MAX_PARTES).forEach((p, i) => {
      if (!ehObjeto(p)) return;
      for (const [campo, bruto] of Object.entries(p)) {
        if (!CAMPOS_DA_PESSOA.has(campo)) continue;
        const v = validar(campo, bruto);
        if (v) poe(`${lista}[${i}].${campo}`, v);
      }
    });
  }

  const imovel = args.imovel;
  if (ehObjeto(imovel)) {
    for (const [campo, bruto] of Object.entries(imovel)) {
      if (!CAMPOS_DO_IMOVEL.has(campo)) continue;
      const v = texto(bruto);
      // O modelo pode normalizar caixa/acento: exige que o miolo exista no texto.
      if (v && sem(v).split(" ").every((p) => norm.includes(p) || p.length <= 2)) poe(`imovel.${campo}`, umaLinha(v, 120));
    }
  }

  const neg = args.negociacao;
  if (ehObjeto(neg)) {
    for (const [campo, bruto] of Object.entries(neg)) {
      if (!CAMPOS_DA_NEGOCIACAO.has(campo)) continue;
      if (campo === "valor" || campo === "sinal") {
        const n = valorEmReais(bruto);
        if (n !== null && valoresCitados.some((c) => Math.abs(c - n) < 0.01)) poe(`negociacao.${campo}`, String(n));
      } else if (campo === "prazo_meses") {
        const n = typeof bruto === "number" ? bruto : Number(texto(bruto));
        if (Number.isInteger(n) && n > 0 && n <= 600 && norm.includes(String(n))) poe("negociacao.prazo_meses", String(n));
      } else if (campo === "data_entrada") {
        const v = validar(campo, bruto);
        if (v) poe("negociacao.data_entrada", v, 0.7);
      } else {
        const v = texto(bruto);
        if (v) poe("negociacao.modalidade", umaLinha(v, 40), 0.7);
      }
    }
  }

  const corretor = args.corretor;
  if (ehObjeto(corretor)) {
    const creci = texto(corretor.creci);
    if (creci && digitosDoTexto.includes(so(creci)) && so(creci).length > 0) poe("corretor.creci", umaLinha(creci, 20));
  }

  const obs = texto(args.observacoes);
  if (obs) poe("observacoes", umaLinha(obs, 300), 0.7);

  return out;
}
