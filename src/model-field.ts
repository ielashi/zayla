/**
 * The Model field of a Provider form, in Settings and in Setup alike: what it
 * holds, and the list of models under it. The list is the page's own rather
 * than a datalist, which can't carry a tag and hides whatever doesn't match the
 * field. It names only the parts of the page it uses rather than the DOM's
 * types, because the server's typecheck, which has none, reads it too, and so
 * the tests can hand it the real page without running it.
 */
import { RECOMMENDED_MODEL } from "./core/openrouter.ts";
import { html, setHtml } from "./html.ts";
import type { ProviderKind } from "./shared.ts";

/** As much of a document as a Model field needs. */
type Page = { getElementById(id: string): unknown };

/** As much of an element as a Model field listens to. */
type Listens = {
  addEventListener<E>(type: string, then: (event: E) => void): void;
};

type Key = {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
};

type Press = {
  target: {
    closest(selector: string): { getAttribute(name: string): string } | null;
  };
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
  const model = part<
    Listens & {
      value: string;
      setAttribute(name: string, value: string): void;
    }
  >("model");
  const list = part<
    Listens & {
      hidden: boolean;
      innerHTML: string;
      querySelector(selector: string): {
        scrollIntoView(options: { block: "nearest" }): void;
      } | null;
    }
  >("models");
  const note = part<{ hidden: boolean }>("recommended");
  part<{ textContent: string }>("recommended-name").textContent =
    RECOMMENDED_MODEL;

  let kind: ProviderKind = "openrouter";
  /** Every model listed for this destination. */
  let offered: string[] = [];
  /** Those the list shows now; none while it is closed. */
  let shown: string[] = [];
  /** The one the arrow keys are on, as an index into `shown`, or -1. */
  let active = -1;

  const optionId = (index: number) => `${prefix}-model-${index}`;

  const draw = () => {
    setHtml(
      list,
      html`${shown.map(
        (id, index) =>
          html`<div role="option" class="prov-model" id="${optionId(index)}" data-model="${id}" aria-selected="${String(index === active)}">
            <span class="prov-model-id">${id}</span>
            ${kind === "openrouter" && id === RECOMMENDED_MODEL && html`<span class="prov-tag">Recommended</span>`}
          </div>`,
      )}`,
    );
    list.hidden = shown.length === 0;
    model.setAttribute("aria-expanded", String(shown.length > 0));
    model.setAttribute(
      "aria-activedescendant",
      active < 0 ? "" : optionId(active),
    );
    if (active >= 0)
      list
        .querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  };

  const show = (models: string[]) => {
    shown = models;
    active = -1;
    draw();
  };

  const choose = (id: string) => {
    model.value = id;
    show([]);
  };

  /** Draw the field for a Provider of this kind holding `id`, or none. */
  const fill = (toKind: ProviderKind, id: string) => {
    kind = toKind;
    model.value = id || (kind === "openrouter" ? RECOMMENDED_MODEL : "");
    note.hidden = kind !== "openrouter";
    offered = [];
    show([]);
  };

  model.addEventListener("focus", () => show(offered));
  model.addEventListener("click", () => {
    if (!shown.length) show(offered);
  });
  model.addEventListener("blur", () => show([]));
  model.addEventListener("input", () => {
    const typed = model.value.toLowerCase();
    show(offered.filter((id) => id.toLowerCase().includes(typed)));
  });
  model.addEventListener<Key>("keydown", (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const highlighted = shown[active];
    if (step) {
      event.preventDefault();
      if (!shown.length) shown = offered;
      if (!shown.length) return;
      // From nothing highlighted, up lands on the last and down on the first.
      active =
        active < 0 && step < 0
          ? shown.length - 1
          : (active + step + shown.length) % shown.length;
      draw();
    } else if (event.key === "Enter" && highlighted) {
      event.preventDefault();
      choose(highlighted);
    } else if (event.key === "Escape" && shown.length) {
      // Closes the list only: the same key would close the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      show([]);
    }
  });
  // Pressing the list would take focus from the field, and so close it.
  list.addEventListener<{ preventDefault(): void }>("mousedown", (event) =>
    event.preventDefault(),
  );
  list.addEventListener<Press>("click", (event) => {
    const option = event.target.closest("[data-model]");
    if (option) choose(option.getAttribute("data-model"));
  });

  return {
    fill,
    /** The form changed kind: only what Zayla put in the field goes with it. */
    switchKind(toKind: ProviderKind) {
      fill(toKind, model.value === RECOMMENDED_MODEL ? "" : model.value);
    },
    /** Drop the list: it was for another destination. */
    forgetOffers() {
      offered = [];
      show([]);
    },
    /** List these models under the field; returns what to say about them. */
    offer(models: string[]): string {
      offered = kind === "openrouter" ? recommendedFirst(models) : models;
      show(offered);
      return models.length
        ? `${models.length} model${models.length === 1 ? "" : "s"} offered — pick one, or type an id.`
        : "That address offers no models; type the id instead.";
    },
  };
}
