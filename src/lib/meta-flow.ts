/**
 * O WhatsApp Flow da revisão da proposta no Max (PR-C, T11, decisão D1).
 *
 * Um Flow POR PASSO de revisão (`partes`, `imovel_valor`, `assinatura`), não um formulário
 * gigante. Tudo aqui é função pura:
 *
 *  - os campos e as opções vêm do `options` do servidor (catálogo FECHADO da org): o Flow nunca
 *    oferece um campo ou uma opção que o `options` não trouxe;
 *  - `montarFlowDeRevisao` devolve a tela e o `data` pré-preenchido do envio
 *    (`interactive.type="flow"`, `flow_action="navigate"`);
 *  - `definicaoDoFlow` gera o JSON do Flow (versão `FLOW_SCHEMA_VERSION`) a partir do
 *    `obrigatorios[]`, para publicar na WABA;
 *  - `lerRespostaDoFlow` valida a resposta (`nfm_reply`) e a transforma num patch pela MESMA
 *    leitura do texto livre (`lerCampoPorCaminho`). A resposta é DADO, nunca instrução: chave
 *    fora do catálogo, tipo estranho ou valor inválido = `{ erro: "formato" }`, nada anotado.
 *
 * Sem `MAX_FLOW_ID_*` do passo (ou fora do Max, ou com `MAX_INTERACTIVE=off`) o Flow não sai: a
 * revisão cai na lista numerada, botões/lista (`flowDoPasso` devolve `null`).
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CampoObrigatorio, OptionsV2, PatchV2, TipoDeAssinatura } from "@/graph/formularios/contrato";
import type { PassoDeRevisao } from "@/graph/formularios/estado";
import { contagemDePartes } from "@/graph/formularios/partes";
import { caminhoCanonico, lerCampoPorCaminho } from "@/graph/formularios/proposta-v2";
import { deployProfile } from "./deploy-profile";
import { interativoDisponivel, type InterativoFlow } from "./transport";

export const FLOW_SCHEMA_VERSION = "7.0";

export type { PassoDeRevisao };

/** Uma tela por parte, até 4 (D1). */
export const MAX_PARTES_NO_FLOW = 4;

const ENV_DO_PASSO: Record<PassoDeRevisao, string> = {
  partes: "MAX_FLOW_ID_REVISAR_PARTES",
  imovel_valor: "MAX_FLOW_ID_REVISAR_IMOVEL_VALOR",
  assinatura: "MAX_FLOW_ID_REVISAR_ASSINATURA",
};

/** O id do Flow publicado para o passo, ou `null` (não configurado: a revisão cai nos botões/lista). */
export function flowIdDoPasso(passo: PassoDeRevisao, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env[ENV_DO_PASSO[passo]] ?? "").trim();
  return v.length > 0 ? v : null;
}

// ─── Campos do passo (catálogo fechado) ─────────────────────────────────────

export interface CampoDoFlow {
  /** Nome do campo no Flow (alfanumérico + `_`): o caminho canônico achatado. */
  nome: string;
  /** Caminho canônico do rascunho (`compradores[0].cpf`). */
  path: string;
  rotulo: string;
  tipo: CampoObrigatorio["tipoCampo"];
  opcoes?: Array<{ id: string; rotulo: string }>;
  tela: string;
}

/** `compradores[0].cpf` → `compradores_0__cpf`; `negociacao.valor` → `negociacao__valor`. Reversível. */
export function nomeDoCampoFlow(path: string): string {
  return path.replace(/\[(\d+)\]/g, "_$1").replace(/\./g, "__");
}

export function caminhoDoCampoFlow(nome: string): string | null {
  let m = /^(compradores|vendedores)_(\d)__([a-z_0-9]+)$/.exec(nome);
  if (m) return `${m[1]}[${m[2]}].${m[3]}`;
  m = /^(imovel|negociacao)__([a-z_0-9]+)$/.exec(nome);
  if (m) return `${m[1]}.${m[2]}`;
  return null;
}

/**
 * Quantas partes o Flow mostra por lado (mínimo 1: a tela da primeira parte sempre existe).
 * Piso vindo de `signatarios` (só quem assina): enquanto o `options` não trouxer as partes do
 * rascunho por posição, parte que não assina pode não ganhar tela.
 */
export function contarPartes(options: OptionsV2): { compradores: number; vendedores: number } {
  return contagemDePartes(options);
}

const PREFIXO_DO_LADO: Record<string, "compradores" | "vendedores"> = { proponente: "compradores", contraparte: "vendedores" };

/** Os campos que o passo mostra, na ordem do `obrigatorios[]`. `assinatura` não tem campo de dado. */
export function camposDoPasso(passo: PassoDeRevisao, options: OptionsV2): CampoDoFlow[] {
  const obrigatorios = options.obrigatorios ?? [];
  const out: CampoDoFlow[] = [];
  if (passo === "partes") {
    const n = contarPartes(options);
    // Telas por parte: compradores primeiro, depois vendedores, no máximo 4 no total.
    const partes: Array<{ lado: "compradores" | "vendedores"; indice: number }> = [];
    for (let i = 0; i < n.compradores; i++) partes.push({ lado: "compradores", indice: i });
    for (let i = 0; i < n.vendedores; i++) partes.push({ lado: "vendedores", indice: i });
    partes.splice(MAX_PARTES_NO_FLOW);
    partes.forEach((parte, tela) => {
      for (const o of obrigatorios) {
        const m = /^(proponente|contraparte)\.[a-z_0-9]+$/.exec(o.chave);
        if (!m || PREFIXO_DO_LADO[m[1]!] !== parte.lado) continue;
        // A mesma tradução do texto livre (`documento` → `cpf`): o Flow fala o caminho canônico do rascunho.
        const path = caminhoCanonico(o.chave, { posicao: parte.indice + 1, papel: "" });
        out.push({ nome: nomeDoCampoFlow(path), path, rotulo: o.rotulo, tipo: o.tipoCampo, ...(o.opcoes ? { opcoes: o.opcoes } : {}), tela: `PARTE_${tela + 1}` });
      }
    });
  } else if (passo === "imovel_valor") {
    for (const o of obrigatorios) {
      const m = /^(imovel|negociacao)\.[a-z_0-9]+$/.exec(o.chave);
      if (!m) continue;
      out.push({ nome: nomeDoCampoFlow(o.chave), path: o.chave, rotulo: o.rotulo, tipo: o.tipoCampo, ...(o.opcoes ? { opcoes: o.opcoes } : {}), tela: "IMOVEL_VALOR" });
    }
  }
  return out;
}

const TITULO_DO_TIPO: Record<TipoDeAssinatura, string> = { email: "Por e-mail", whatsapp: "Por WhatsApp", aceite: "Aceite no celular" };

const titulo = (s: string): string => s.slice(0, 30);

/** O que o Flow oferece como `tipo_assinatura`: só o que o `options` diz estar disponível. */
export function tiposDoFlow(options: OptionsV2): Array<{ id: TipoDeAssinatura; title: string; description?: string }> {
  return (options.tiposDeAssinatura ?? [])
    .filter((t) => t.disponivel && t.tipo in TITULO_DO_TIPO)
    .map((t) => ({ id: t.tipo, title: TITULO_DO_TIPO[t.tipo], ...(t.texto ? { description: t.texto.slice(0, 72) } : {}) }));
}

/** O que o Flow oferece como testemunha: só as do cadastro (`testemunhas.padrao`), sem CPF/e-mail/celular. */
export function testemunhasDoCatalogo(options: OptionsV2): Array<{ id: string; title: string }> {
  return (options.testemunhas?.padrao ?? []).map((t) => ({ id: t.idPadrao, title: titulo(t.nome) }));
}

// ─── Montagem do envio ──────────────────────────────────────────────────────

/**
 * A tela inicial e o `data` do envio. `valores` é `caminho canônico → valor` do que já se sabe
 * (nomes das partes, por exemplo); chave fora do catálogo do passo é DESCARTADA (catálogo fechado).
 */
export function montarFlowDeRevisao(
  passo: PassoDeRevisao,
  options: OptionsV2,
  valores: Record<string, string>
): { screen: string; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  if (passo === "assinatura") {
    data.tipo_assinatura_opcoes = tiposDoFlow(options);
    data.testemunhas_opcoes = testemunhasDoCatalogo(options);
    return { screen: "ASSINATURA", data };
  }
  const campos = camposDoPasso(passo, options);
  for (const c of campos) {
    // Só texto livre (nome) vai pré-preenchido; CPF/CNPJ, telefone e e-mail nunca saem no `data` (PII no payload da Meta).
    data[c.nome] = c.tipo === "texto" ? (valores[c.path] ?? "") : "";
    if (c.opcoes) data[`${c.nome}_opcoes`] = c.opcoes.map((o) => ({ id: o.id, title: titulo(o.rotulo) }));
  }
  return { screen: campos[0]?.tela ?? (passo === "partes" ? "PARTE_1" : "IMOVEL_VALOR"), data };
}

// ─── O JSON do Flow (para publicar na WABA) ─────────────────────────────────

const INPUT_TYPE: Partial<Record<CampoObrigatorio["tipoCampo"], string>> = {
  texto: "text",
  numero: "number",
  moeda: "text",
  cpf_cnpj: "text",
  telefone: "phone",
  email: "email",
};

type Json = Record<string, unknown>;

function componenteDoCampo(c: CampoDoFlow): Json {
  const init = `\${data.${c.nome}}`;
  if (c.tipo === "opcao" && c.opcoes) {
    return { type: "Dropdown", label: titulo(c.rotulo), name: c.nome, required: false, "data-source": `\${data.${c.nome}_opcoes}` };
  }
  if (c.tipo === "data") return { type: "DatePicker", label: titulo(c.rotulo), name: c.nome, required: false, "init-value": init };
  return { type: "TextInput", label: titulo(c.rotulo), name: c.nome, "input-type": INPUT_TYPE[c.tipo] ?? "text", required: false, "init-value": init };
}

/**
 * O JSON do Flow do passo, gerado do `obrigatorios[]` (e das opções da org). Versionado por
 * `FLOW_SCHEMA_VERSION`. Cada campo do JSON está em `camposDoPasso` / `tiposDoFlow` /
 * `testemunhasDoCatalogo`: não existe campo escrito à mão.
 */
export function definicaoDoFlow(passo: PassoDeRevisao, options: OptionsV2): Json {
  if (passo === "assinatura") {
    return {
      version: FLOW_SCHEMA_VERSION,
      screens: [
        {
          id: "ASSINATURA",
          title: "Assinatura",
          terminal: true,
          success: true,
          data: {
            tipo_assinatura_opcoes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" } } }, __example__: [] },
            testemunhas_opcoes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } }, __example__: [] },
          },
          layout: {
            type: "SingleColumnLayout",
            children: [
              {
                type: "Form",
                name: "form",
                children: [
                  { type: "RadioButtonsGroup", label: "Como assinam", name: "tipo_assinatura", required: true, "data-source": "${data.tipo_assinatura_opcoes}" },
                  { type: "CheckboxGroup", label: "Testemunhas", name: "testemunhas", required: false, "data-source": "${data.testemunhas_opcoes}" },
                  {
                    type: "Footer",
                    label: "Enviar",
                    "on-click-action": { name: "complete", payload: { tipo_assinatura: "${form.tipo_assinatura}", testemunhas: "${form.testemunhas}" } },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
  }
  const campos = camposDoPasso(passo, options);
  const telas = [...new Set(campos.map((c) => c.tela))];
  if (telas.length === 0) telas.push(passo === "partes" ? "PARTE_1" : "IMOVEL_VALOR");
  const screens = telas.map((id, i) => {
    const meus = campos.filter((c) => c.tela === id);
    const anteriores = campos.filter((c) => telas.indexOf(c.tela) < i);
    const ultima = i === telas.length - 1;
    const payload: Json = {};
    for (const c of anteriores) payload[c.nome] = `\${data.${c.nome}}`;
    for (const c of meus) payload[c.nome] = `\${form.${c.nome}}`;
    const dados: Json = {};
    for (const c of [...anteriores, ...meus]) {
      dados[c.nome] = { type: "string", __example__: "" };
      if (c.opcoes) dados[`${c.nome}_opcoes`] = { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } }, __example__: [] };
    }
    return {
      id,
      title: passo === "partes" ? `Parte ${i + 1}` : "Imóvel e valor",
      ...(ultima ? { terminal: true, success: true } : {}),
      data: dados,
      layout: {
        type: "SingleColumnLayout",
        children: [
          {
            type: "Form",
            name: "form",
            children: [
              ...meus.map(componenteDoCampo),
              {
                type: "Footer",
                label: ultima ? "Enviar" : "Próxima",
                "on-click-action": ultima ? { name: "complete", payload } : { name: "navigate", next: { type: "screen", name: telas[i + 1]! }, payload },
              },
            ],
          },
        ],
      },
    };
  });
  return { version: FLOW_SCHEMA_VERSION, routing_model: Object.fromEntries(telas.map((t, i) => [t, i < telas.length - 1 ? [telas[i + 1]!] : []])), screens };
}

// ─── Leitura da resposta ────────────────────────────────────────────────────

const RespostaSchema = z
  .record(z.string().max(60), z.union([z.string().max(300), z.number().finite(), z.array(z.string().max(80)).max(20)]))
  .refine((r) => Object.keys(r).length > 0 && Object.keys(r).length <= 60);

/** `semMudanca`: o Flow voltou só com o que já estava preenchido (ou em branco): não há correção a anotar. */
export type RespostaDoFlow = PatchV2 | { erro: "formato"; invalidos?: string[] } | { semMudanca: true };

function juntar(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const atual = out[k];
    if (Array.isArray(atual) && Array.isArray(v)) {
      // Listas de partes por POSIÇÃO: `[{}, {cpf}]` + `[{nome}]` = `[{nome}, {cpf}]`.
      const n = Math.max(atual.length, v.length);
      out[k] = Array.from({ length: n }, (_, i) => ({ ...(atual[i] as object | undefined), ...(v[i] as object | undefined) }));
    } else if (atual && typeof atual === "object" && v && typeof v === "object" && !Array.isArray(atual)) {
      out[k] = { ...(atual as object), ...(v as object) };
    } else out[k] = v;
  }
  return out;
}

const TIPOS_DE_ASSINATURA = new Set<string>(["email", "whatsapp", "aceite"]);

/**
 * A resposta do Flow (já sem o `flow_token`, `meta.ts::lerFlowResponse`) como patch do rascunho.
 * NUNCA grava: o patch vira campo lido, ficha e o "sim" de sempre. Qualquer chave fora do catálogo
 * do passo, valor de tipo estranho ou campo que a leitura local recusa devolve `{ erro: "formato" }`
 * (com os caminhos recusados, sem valor), e nada é anotado, nem os campos bons.
 *
 * `preenchidos` (caminho → valor que o envio levava) descarta o campo devolvido IGUAL ao
 * pré-preenchido: o Flow devolve todos os campos com `init-value`, e isso não é correção.
 */
export function lerRespostaDoFlow(
  flowResponse: unknown,
  passo: string,
  obrigatorios?: CampoObrigatorio[],
  preenchidos: Record<string, string> = {}
): RespostaDoFlow {
  const parsed = RespostaSchema.safeParse(flowResponse);
  if (!parsed.success) return { erro: "formato" };
  const resposta = parsed.data;
  if (passo === "assinatura") {
    const chaves = Object.keys(resposta).filter((k) => k !== "testemunhas");
    const tipo = resposta.tipo_assinatura;
    if (chaves.length !== 1 || chaves[0] !== "tipo_assinatura" || typeof tipo !== "string" || !TIPOS_DE_ASSINATURA.has(tipo)) return { erro: "formato" };
    return { tipo_assinatura: tipo as TipoDeAssinatura };
  }
  if (passo !== "partes" && passo !== "imovel_valor") return { erro: "formato" };
  let patch: Record<string, unknown> = {};
  const invalidos: string[] = [];
  let lidos = 0;
  let iguais = 0;
  for (const [nome, bruto] of Object.entries(resposta)) {
    const path = caminhoDoCampoFlow(nome);
    const doPasso = path !== null && (passo === "partes" ? /^(compradores|vendedores)\[/.test(path) : /^(imovel|negociacao)\./.test(path));
    if (!path || !doPasso) return { erro: "formato" };
    if (Array.isArray(bruto)) return { erro: "formato" };
    const texto = String(bruto).trim();
    if (texto === "") continue; // campo em branco = não mexeu
    const antes = preenchidos[path];
    if (antes !== undefined && antes.trim() === texto) {
      iguais++; // devolvido como veio: não é correção
      continue;
    }
    const r = lerCampoPorCaminho(path, "revisao", texto, obrigatorios);
    if (r.tipo !== "preenche") {
      invalidos.push(path);
      continue;
    }
    patch = juntar(patch, r.patch as Record<string, unknown>);
    lidos++;
  }
  if (invalidos.length > 0) return { erro: "formato", invalidos };
  if (lidos === 0) return iguais > 0 ? { semMudanca: true } : { erro: "formato" };
  return patch as PatchV2;
}

/** As testemunhas marcadas no Flow de assinatura, só se TODAS estão no cadastro (`testemunhas.padrao`). */
export function lerTestemunhasDoFlow(flowResponse: unknown, options: OptionsV2): string[] | null {
  const parsed = RespostaSchema.safeParse(flowResponse);
  if (!parsed.success) return null;
  const marcadas = parsed.data.testemunhas ?? [];
  if (!Array.isArray(marcadas)) return null;
  const conhecidas = new Set(testemunhasDoCatalogo(options).map((t) => t.id));
  return marcadas.every((id) => conhecidas.has(id)) ? marcadas : null;
}

/**
 * A resposta do Flow como o `meta.ts` a deixa no texto ("campo: valor" por linha, o `flow_token`
 * já fora). O objeto bruto não é guardado na fila (levaria CPF para uma coluna jsonb), então o
 * consumidor o relê daqui. Só linhas `nome: valor` com nome do catálogo do Flow; qualquer linha
 * fora disso = `null` (não é resposta de Flow, segue como fala normal). `testemunhas` volta lista.
 */
export function flowDoTexto(texto: string): Record<string, unknown> | null {
  const linhas = texto.split("\n").filter((l) => l.trim() !== "");
  if (linhas.length === 0 || linhas.length > 60) return null;
  const out: Record<string, unknown> = {};
  for (const l of linhas) {
    const m = /^([a-z0-9_]{1,60}): (.*)$/s.exec(l);
    if (!m) return null;
    const nome = m[1]!;
    if (nome !== "tipo_assinatura" && nome !== "testemunhas" && caminhoDoCampoFlow(nome) === null) return null;
    out[nome] = nome === "testemunhas" ? m[2]!.split(", ").filter(Boolean) : m[2]!;
  }
  return out;
}

// ─── Envio ──────────────────────────────────────────────────────────────────

/**
 * O Flow do passo pode sair agora? Os QUATRO precisam valer: perfil Max (o Newton/Z-API nunca
 * recebe Flow), o id do Flow do passo configurado (`MAX_FLOW_ID_*`), o provedor aceitar mensagem
 * interativa e o kill switch `MAX_INTERACTIVE` não estar em `off`. Qualquer falha = `null`, e a
 * revisão cai na lista numerada (botões/lista derivados do texto, como antes).
 */
export function flowDisponivel(passo: PassoDeRevisao, env: NodeJS.ProcessEnv = process.env): { flowId: string } | null {
  if (deployProfile().agentKey !== "max") return null;
  const flowId = flowIdDoPasso(passo, env);
  if (!flowId || !interativoDisponivel()) return null;
  return { flowId };
}

// ─── O token do Flow (amarra a resposta ao envio) ───────────────────────────

/** Prefixo do `flow_token` do Max (`fv2:<passo>:<nonce>`); `meta.ts` só repassa tokens com ele. */
export const PREFIXO_DO_TOKEN_DO_FLOW = "fv2:";
/** O `button_payload` que guarda o token da resposta de um Flow nosso. */
export const PREFIXO_DO_BOTAO_DO_FLOW = "flow:";

/** Um segredo por envio de Flow (não é PII): sem ele a resposta de um Flow antigo ou digitada não vale. */
export function novoNonceDoFlow(): string {
  return randomBytes(9).toString("base64url");
}

export function tokenDoFlow(passo: PassoDeRevisao, nonce: string): string {
  return `${PREFIXO_DO_TOKEN_DO_FLOW}${passo}:${nonce}`;
}

/** O token que o `button_payload` da resposta carrega (`flow:<token>`), ou `null` se não é de Flow nosso. */
export function tokenDoBotao(botao: string | null | undefined): string | null {
  if (!botao || !botao.startsWith(PREFIXO_DO_BOTAO_DO_FLOW)) return null;
  const token = botao.slice(PREFIXO_DO_BOTAO_DO_FLOW.length);
  return token === "" ? null : token;
}

/**
 * A mensagem de Flow do passo (o `interactive.type="flow"`), ou `null` quando ele não pode sair.
 * `nonce` é o do estado da revisão: o token do envio é `fv2:<passo>:<nonce>`.
 */
export function montarEnvioDoFlow(
  passo: PassoDeRevisao,
  options: OptionsV2,
  valores: Record<string, string>,
  corpo: string,
  nonce: string,
  env: NodeJS.ProcessEnv = process.env
): InterativoFlow | null {
  const ok = flowDisponivel(passo, env);
  if (!ok) return null;
  const { screen, data } = montarFlowDeRevisao(passo, options, valores);
  return { tipo: "flow", flowId: ok.flowId, screen, data, corpo, cta: "Revisar", flowToken: tokenDoFlow(passo, nonce) };
}

/**
 * CACHE (nunca a fonte) entre o condutor, que decide o Flow, e o envio (`inbound.ts`), no mesmo
 * processo e por `messageId`, como o `TURNO_CRU` do grafo. A fonte é o estado da revisão (passo,
 * itens, nonce): o texto numerado, que é o corpo e a reserva do Flow, sai sempre do `reply`. Sem
 * o cache (outro processo, retentativa depois de reiniciar, vencido) a revisão sai em texto e
 * nada se perde. Não vai ao checkpoint nem à fila (o `data` carrega nome de parte). Entradas
 * vencem em `VALIDADE_DO_CANAL_MS` (playground, resposta vazia e ficha agendada nunca o consomem).
 */
const FLOW_DO_TURNO = new Map<string, { flow: InterativoFlow; em: number }>();
const TETO_DO_CANAL = 200;
export const VALIDADE_DO_CANAL_MS = 10 * 60_000;

function podarCanal(agora: number): void {
  for (const [k, v] of FLOW_DO_TURNO) if (agora - v.em > VALIDADE_DO_CANAL_MS) FLOW_DO_TURNO.delete(k);
}

export function registrarFlowDoTurno(messageId: string, flow: InterativoFlow, agora: number = Date.now()): void {
  podarCanal(agora);
  if (FLOW_DO_TURNO.size >= TETO_DO_CANAL) {
    const antigo = FLOW_DO_TURNO.keys().next().value;
    if (antigo !== undefined) FLOW_DO_TURNO.delete(antigo);
  }
  FLOW_DO_TURNO.set(messageId, { flow, em: agora });
}

/** Lê sem tirar: a retentativa do envio (falha, outro worker) ainda o encontra. Vencido = ausente. */
export function espiarFlowDoTurno(messageId: string, agora: number = Date.now()): InterativoFlow | undefined {
  const e = FLOW_DO_TURNO.get(messageId);
  if (!e) return undefined;
  if (agora - e.em > VALIDADE_DO_CANAL_MS) {
    FLOW_DO_TURNO.delete(messageId);
    return undefined;
  }
  return e.flow;
}

/** O envio foi aceito (ou o turno acabou): o Flow não volta a sair. */
export function descartarFlowDoTurno(messageId: string): void {
  FLOW_DO_TURNO.delete(messageId);
}

export function consumirFlowDoTurno(messageId: string, agora: number = Date.now()): InterativoFlow | undefined {
  const flow = espiarFlowDoTurno(messageId, agora);
  FLOW_DO_TURNO.delete(messageId);
  return flow;
}
