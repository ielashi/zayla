/**
 * The Reading languages of a form, in Settings and in Setup alike: a list that
 * holds as many as the user chose, and a picker that offers the rest. It names
 * only the parts of the page it uses rather than the DOM's types, because the
 * server's typecheck, which has none, reads it too, and so the tests can hand
 * it the real page without running it.
 */
import { html, setHtml } from "./html.ts";
import {
  languageName,
  MAX_READING_LANGUAGES,
  OFFERED_LANGUAGES,
  TESTED_LANGUAGES,
} from "./languages.ts";

/** As much of a document as a language list needs. */
type Page = { getElementById(id: string): unknown };

/** As much of an element as a language list listens to. */
type Listens = {
  addEventListener<E>(type: string, then: (event: E) => void): void;
};

type Focusable = { focus(): void };

type Press = {
  target: {
    closest(selector: string): { getAttribute(name: string): string } | null;
  };
};

const UP_ICON = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const REMOVE_ICON = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** The language list of the form whose ids start with `prefix`. */
export function languageList(
  page: Page,
  prefix: string,
  onEdit: () => void = () => {},
) {
  const list = page.getElementById(`${prefix}-list`) as Listens & {
    innerHTML: string;
    querySelector(selector: string): Focusable | null;
  };
  const picker = page.getElementById(`${prefix}-add`) as Listens &
    Focusable & {
      value: string;
      hidden: boolean;
      innerHTML: string;
    };

  let languages: string[] = [];

  /** The picker's options, without what is chosen: the tested languages first, in their own order, then the rest by name. */
  const drawPicker = () => {
    const option = (code: string) =>
      html`<option value="${code}">${languageName(code)}</option>`;
    const group = (label: string, codes: string[]) =>
      codes.length > 0 &&
      html`<optgroup label="${label}">${codes.map(option)}</optgroup>`;
    const unchosen = OFFERED_LANGUAGES.filter((c) => !languages.includes(c));
    const tested = TESTED_LANGUAGES.filter((c) => unchosen.includes(c));
    const untested = unchosen
      .filter((c) => !TESTED_LANGUAGES.includes(c))
      .sort((a, b) => languageName(a).localeCompare(languageName(b)));
    setHtml(
      picker,
      html`<option value="">Add a language</option>${group("Tested", tested)}${group("Untested", untested)}`,
    );
    picker.value = "";
    picker.hidden = languages.length >= MAX_READING_LANGUAGES;
  };

  const draw = () => {
    setHtml(
      list,
      html`${languages.map(
        (code, index) =>
          html`<li class="lang-row">
            <span class="lang-name">${languageName(code)}</span>
            ${index === 0 && html`<span class="lang-tag">Main</span>`}
            <span class="lang-actions">
              ${index > 0 && html`<button type="button" class="lang-btn" data-action="up" data-index="${index}" aria-label="Move ${languageName(code)} up" title="Move up">${UP_ICON}</button>`}
              ${languages.length > 1 && html`<button type="button" class="lang-btn" data-action="remove" data-index="${index}" aria-label="Remove ${languageName(code)}" title="Remove">${REMOVE_ICON}</button>`}
            </span>
          </li>`,
      )}`,
    );
    drawPicker();
  };

  /** A row's button; a row holds only the buttons that apply to it. */
  const rowButton = (action: "up" | "remove", index: number) =>
    list.querySelector(`[data-action="${action}"][data-index="${index}"]`);

  /** Draw what changed, with focus on what it left behind: the old control is gone. */
  const redrawAfterEdit = (focusNext: () => Focusable | null) => {
    draw();
    focusNext()?.focus();
    onEdit();
  };

  picker.addEventListener("change", () => {
    if (!picker.value) return;
    languages.push(picker.value);
    redrawAfterEdit(() =>
      picker.hidden ? rowButton("remove", languages.length - 1) : picker,
    );
  });

  list.addEventListener<Press>("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const index = Number(button.getAttribute("data-index"));
    const [code] = languages.splice(index, 1);
    if (button.getAttribute("data-action") === "remove") {
      redrawAfterEdit(() => rowButton("remove", index) ?? picker);
    } else if (code) {
      languages.splice(index - 1, 0, code);
      redrawAfterEdit(
        () => rowButton("up", index - 1) ?? rowButton("remove", index - 1),
      );
    }
  });

  draw();

  return {
    /** Draw the list holding these languages. */
    show(chosen: string[]) {
      languages = [...chosen];
      draw();
    },
    /** The languages held now, in order of preference. */
    languages: () => [...languages],
  };
}
