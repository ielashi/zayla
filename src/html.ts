/**
 * Markup the frontend builds from strings, escaped unless it says otherwise.
 *
 * What the page shows is mostly what a model read out of the owner's
 * Documents — titles, summaries, the names of senders — and a Document can say
 * anything, markup included. So every value put into a `html` template is
 * escaped, and markup is only ever markup because it was written as a
 * template's literal text or came out of another template. Forgetting to escape
 * is then not something the code can do; leaving a value unescaped takes `raw`,
 * which is meant to be rare enough to read every use of.
 *
 * Like shared.ts this touches no DOM and imports nothing, so the server's
 * typecheck and the tests can read it as well as the browser.
 */

/** Markup that is safe to put into the page as it stands. */
export class Html {
  constructor(readonly markup: string) {}
}

/**
 * What a template may interpolate: markup as it is, text and numbers escaped,
 * a list one item after the other, and nothing at all for null, undefined or
 * false — which is what `cond && html\`…\`` gives when `cond` doesn't hold.
 */
export type HtmlValue =
  | Html
  | string
  | number
  | null
  | undefined
  | false
  | readonly HtmlValue[];

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text as markup that shows it, in an element's content or a quoted attribute alike. */
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

function markupOf(value: HtmlValue): string {
  if (value instanceof Html) return value.markup;
  if (Array.isArray(value)) return value.map(markupOf).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

/** A template whose literal text is markup and whose every value is escaped. */
export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): Html {
  let markup = strings[0] ?? "";
  values.forEach((value, i) => {
    markup += markupOf(value) + (strings[i + 1] ?? "");
  });
  return new Html(markup);
}

/** Items one after another with a separator between them, as `Array.join` does with strings. */
export const join = (items: readonly HtmlValue[], separator: Html) =>
  new Html(items.map(markupOf).join(separator.markup));

/**
 * Markup written as a string, trusted as it is. Only for markup that is a
 * constant of the code itself — never for anything that came over the wire.
 */
export const raw = (markup: string) => new Html(markup);

/**
 * Replace an element's content with this markup. The one place the frontend
 * writes `innerHTML`: elsewhere it is refused (see html.test.ts), so markup
 * only reaches the page by having been built here.
 */
export function setHtml(node: { innerHTML: string }, content: Html) {
  node.innerHTML = content.markup;
}
