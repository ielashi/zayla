/**
 * The Model field of a Provider form, in Settings and in Setup alike: what it
 * holds, and what it suggests. It names only the parts of the page it uses
 * rather than the DOM's types, because the server's typecheck, which has none,
 * reads it too, and so the tests can hand it the real page without running it.
 */
import { RECOMMENDED_MODEL } from "./core/openrouter.ts";
import type { ProviderKind } from "./shared.ts";

/** As much of a document as a Model field needs. */
type Page = {
  getElementById(id: string): unknown;
  createElement(tag: "option"): unknown;
};

/** The Recommended model first, when it is among these, and the rest in order. */
const recommendedFirst = (models: string[]) =>
  models.includes(RECOMMENDED_MODEL)
    ? [RECOMMENDED_MODEL, ...models.filter((id) => id !== RECOMMENDED_MODEL)]
    : models;

/** The Model field of the form whose ids start with `prefix`. */
export function modelField(page: Page, prefix: string) {
  const part = <T>(suffix: string) =>
    page.getElementById(`${prefix}-${suffix}`) as T;
  const model = part<{ value: string }>("model");
  const list = part<{ replaceChildren(...options: unknown[]): void }>("models");
  const note = part<{ hidden: boolean }>("recommended");
  part<{ textContent: string }>("recommended-name").textContent =
    RECOMMENDED_MODEL;
  part<{ addEventListener(type: "click", then: () => void): void }>(
    "recommended-use",
  ).addEventListener("click", () => {
    model.value = RECOMMENDED_MODEL;
  });

  let shownKind: ProviderKind = "openrouter";

  /** Draw the field for a Provider of this kind holding `id`, or none. */
  const fill = (kind: ProviderKind, id: string) => {
    shownKind = kind;
    model.value = id || (kind === "openrouter" ? RECOMMENDED_MODEL : "");
    note.hidden = kind !== "openrouter";
    list.replaceChildren();
  };

  return {
    fill,
    /** The form changed kind: only what Zayla put in the field goes with it. */
    switchKind(kind: ProviderKind) {
      fill(kind, model.value === RECOMMENDED_MODEL ? "" : model.value);
    },
    /** Drop the suggestions: they were for another destination. */
    forgetOffers() {
      list.replaceChildren();
    },
    /** Suggest these models; returns what to say about them. */
    offer(models: string[]): string {
      const recommends = shownKind === "openrouter";
      list.replaceChildren(
        ...(recommends ? recommendedFirst(models) : models).map((id) => {
          const option = page.createElement("option") as {
            setAttribute(name: string, value: string): void;
          };
          option.setAttribute("value", id);
          if (recommends && id === RECOMMENDED_MODEL)
            option.setAttribute("label", "Recommended");
          return option;
        }),
      );
      // A browser suggests only what matches the field, so a model left in it
      // would hide the list just asked for. The note can bring it back.
      if (recommends && models.length && model.value === RECOMMENDED_MODEL)
        model.value = "";
      return models.length
        ? `${models.length} model${models.length === 1 ? "" : "s"} offered — pick one, or type an id.`
        : "That address offers no models; type the id instead.";
    },
  };
}
