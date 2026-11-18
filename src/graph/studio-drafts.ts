import { imobproBase } from "@/lib/http";
import type { MarketingPending } from "./marketing";

interface PropertyChoice {
  id: string;
  tipo?: string;
  bairro?: string;
  cidade?: string;
}
type Action = (
  verb: string,
  args: Record<string, unknown>,
  key?: string,
) => Promise<{ status: number; body: Record<string, unknown> } | null>;
type Turn = {
  text: string;
  messageId: string;
  now: number;
  canWrite: boolean;
  policy: readonly string[];
  pending: MarketingPending | null;
};
type Result = {
  reply: string;
  pending: MarketingPending | null;
  event: string;
};

function propertyPage(raw: unknown): PropertyChoice[] {
  return Array.isArray(raw)
    ? raw.filter((p: PropertyChoice) => typeof p?.id === "string").slice(0, 10)
    : [];
}
function propertyPrompt(items: PropertyChoice[], more: boolean) {
  return `Qual imóvel você quer divulgar?\n${items.map((p, i) => `${i + 1}. ${[p.tipo, p.bairro, p.cidade].filter(Boolean).join(" · ") || "Imóvel cadastrado"}`).join("\n")}${more ? "\nDiga mais imóveis para ver a próxima página." : ""}`;
}
function studioLink(id: unknown): string | null {
  if (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)) return null;
  const url = new URL("/marketing", imobproBase());
  url.searchParams.set("draft", id);
  return url.toString();
}
/** Only explicit requests start a draft. Questions about marketing have no effects. */
function requestsCreation(text: string): boolean {
  const command = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(?:(?:oi|ola|max|por favor)[\s,!]+)+/, "")
    .trim();
  if (
    /^(?:nao|nunca|jamais|talvez|explica|explique|ensina|ensine)\b|\bnao (?:quero|crie|gere|faca|monte|prepare)\b/.test(
      command,
    )
  )
    return false;
  return /^(?:(?:eu )?(?:quero|preciso de|gostaria de) (?:que (?:voce )?)?(?:(?:criar|gerar|montar|preparar|fazer) )?(?:um[a]? |o |a |esse |essa )?(?:card|arte|imagem|carrossel|anuncio|post|peca)\b|(?:crie|cria|gere|gera|monte|monta|prepare|prepara|faca|faz)\b|pode (?:criar|gerar|montar|preparar|fazer)\b)/.test(
    command,
  );
}
export async function studioDraftStep(
  turn: Turn,
  action: Action,
): Promise<Result | null> {
  const previous = turn.pending;
  const text = turn.text.trim();
  const finish = (
    reply: string,
    event: string,
    pending: MarketingPending | null = null,
  ) => ({ reply, event, pending });
  const selection = previous?.phase === "studio_property";
  if (previous && !selection && previous.phase !== "tracking") return null;
  const resume =
    /\b(rascunho[s]?|retom(?:ar|e))\b/i.test(text) &&
    /\b(marketing|artes?|cards?|posts?|carrossel|est[uú]dio)\b/i.test(text);
  const agenda =
    /(?:pr[oó]xim[ao]s?|minhas?) pautas?|pautas? (?:editoriais|editorial|de marketing)|cronograma editorial|calend[aá]rio editorial/i.test(
      text,
    );
  const artwork =
    (/\b(arte|card|an[uú]ncio|post|carrossel)\b/i.test(text) ||
      /(?:imagem|peça).*(?:marketing|divulg|im[oó]vel|public|institucional|educativ)/i.test(
        text,
      )) &&
    !/\bv[ií]deo\b/i.test(text);
  if (!selection && !resume && !agenda && !artwork) return null;
  if (!turn.policy.includes("marketing.read"))
    return finish("Marketing não está liberado para você.", "studio_denied");
  if (agenda || resume) {
    const result = await action(
      agenda ? "marketing.editorial_list" : "marketing.draft_list",
      {},
    );
    if (!result || result.status >= 400 || !Array.isArray(result.body.items))
      return finish(
        "Não consegui consultar seu estúdio agora.",
        "studio_query_failed",
      );
    const rows = result.body.items
      .slice(0, 8)
      .flatMap((item: unknown, i: number) => {
        if (!item || typeof item !== "object") return [];
        if (
          agenda &&
          "title" in item &&
          "date" in item &&
          typeof item.title === "string" &&
          typeof item.date === "string"
        ) {
          const link = studioLink("draftId" in item ? item.draftId : undefined);
          return [
            `${item.date.slice(0, 10)} · ${item.title}${link ? "\n" + link : ""}`,
          ];
        }
        const link = studioLink("id" in item ? item.id : undefined);
        return link
          ? [
              `${i + 1}. ${"format" in item && item.format === "carousel" ? "Carrossel" : "Card"} · versão ${"version" in item ? item.version : "atual"}\n${link}`,
            ]
          : [];
      });
    return finish(
      rows.length
        ? rows.join("\n\n")
        : agenda
          ? "Você ainda não tem pautas pendentes."
          : "Você ainda não tem rascunhos.",
      "studio_list",
    );
  }
  if (!turn.canWrite || !turn.policy.includes("marketing.generate"))
    return finish(
      "A criação de peças não está liberada para você.",
      "studio_denied",
    );
  async function create(brief: string, propertyId?: string) {
    const result = await action(
      "marketing.draft_create",
      {
        brief,
        format: /carrossel/i.test(brief) ? "carousel" : "card",
        ...(propertyId ? { propertyId } : {}),
      },
      turn.messageId,
    );
    const link =
      result && result.status < 400 ? studioLink(result.body.id) : null;
    return link
      ? finish(
          `Seu rascunho está no estúdio. Entre com sua conta para revisar, editar e baixar a peça.\n${link}`,
          "studio_prepared",
        )
      : finish(
          "Não consegui confirmar a criação do rascunho. Consulte seus rascunhos no estúdio.",
          "studio_unconfirmed",
        );
  }
  if (selection && previous) {
    if (previous.expiresAt <= turn.now || /^cancelar$/i.test(text))
      return finish("Seleção encerrada.", "studio_cancelled");
    if (/mais im[oó]veis/i.test(text) && previous.cursor) {
      const more = await action("property.list", {
        limite: 10,
        cursor: previous.cursor,
      });
      const items =
        more && more.status < 400 ? propertyPage(more.body.items) : [];
      const cursor =
        typeof more?.body.nextCursor === "string"
          ? more.body.nextCursor
          : undefined;
      return items.length
        ? finish(propertyPrompt(items, !!cursor), "studio_selection", {
            ...previous,
            properties: items,
            cursor,
          })
        : finish(
            "Não consegui consultar outra página agora.",
            "studio_selection",
            previous,
          );
    }
    if (!/^\d+$/.test(text) || !previous.properties?.[Number(text) - 1])
      return finish(
        "Escolha o número do imóvel ou diga cancelar.",
        "studio_selection",
        previous,
      );
    return create(previous.summary, previous.properties[Number(text) - 1].id);
  }
  if (!requestsCreation(text))
    return finish(
      "Para preparar uma peça, diga por exemplo “crie um card educativo sobre visitas” ou “crie uma arte para um imóvel da minha carteira”.",
      "studio_help",
    );
  if (/educativ|institucional|marketing pessoal|sem im[oó]vel/i.test(text))
    return create(text);
  const properties = await action("property.list", { limite: 10 });
  if (
    !properties ||
    properties.status >= 400 ||
    !Array.isArray(properties.body.items)
  ) {
    return finish(
      "Não consegui consultar sua carteira agora. Tente novamente ou abra a ficha no estúdio.",
      "studio_query_failed",
    );
  }
  const items = propertyPage(properties.body.items);
  const cursor =
    typeof properties?.body.nextCursor === "string"
      ? properties.body.nextCursor
      : undefined;
  if (!items.length)
    return finish(
      "Não encontrei imóveis disponíveis na sua carteira. Para conteúdo sem imóvel, peça um card educativo ou institucional.",
      "studio_no_properties",
    );
  return finish(propertyPrompt(items, !!cursor), "studio_selection", {
    phase: "studio_property",
    properties: items,
    cursor,
    summary: text,
    briefId: "",
    confirmationDigest: "",
    expiresAt: turn.now + 10 * 60000,
  });
}
