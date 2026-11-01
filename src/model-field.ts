/**
 * The Model field of a Provider form, in Settings and in Setup alike: what it
 * holds, and what it suggests. It reaches the page only through what it is
 * given, so it stays out of the server's DOM-less typecheck and can be tested
 * against the real page without one running.
 */
import type { ProviderKind } from "./shared.ts";

/** The model suggested for an OpenRouter Provider. Changed by release. */
export const RECOMMENDED_MODEL = "google/gemini-3.6-flash";

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

  return {
    /** Draw the field for a Provider of this kind holding `saved`, or none. */
    fill(kind: ProviderKind, saved: string) {
      model.value = saved || (kind === "openrouter" ? RECOMMENDED_MODEL : "");
      note.hidden = kind !== "openrouter";
      list.replaceChildren();
    },
    /** The form changed kind: only what Zayla put in the field goes with it. */
    switchKind(kind: ProviderKind) {
      const typed = model.value === RECOMMENDED_MODEL ? "" : model.value;
      this.fill(kind, typed);
    },
    /** Drop the suggestions: they were for another destination. */
    forgetOffers() {
      list.replaceChildren();
    },
    /** Suggest these models; returns what to say about them. */
    offer(models: string[]): string {
      list.replaceChildren(
        ...recommendedFirst(models).map((id) => {
          const option = page.createElement("option") as {
            setAttribute(name: string, value: string): void;
          };
          option.setAttribute("value", id);
          if (id === RECOMMENDED_MODEL)
            option.setAttribute("label", "Recommended");
          return option;
        }),
      );
      return models.length
        ? `${models.length} model${models.length === 1 ? "" : "s"} offered — pick one, or type an id.`
        : "That address offers no models; type the id instead.";
    },
  };
}
