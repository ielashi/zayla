import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { languageList } from "./language-list.ts";

const FORMS = ["lang", "setup-lang"];
const window = new Window();

/** The real page, unrun, so a form that lost its parts fails here. */
async function page() {
  return new window.DOMParser().parseFromString(
    await Bun.file(`${import.meta.dir}/../index.html`).text(),
    "text/html",
  );
}

type Page = Awaited<ReturnType<typeof page>>;

/** What a form's list shows: each language, with the tag it carries. */
const rows = (doc: Page, form: string) =>
  [...doc.querySelectorAll(`#${form}-list li`)].map((row) => [
    row.querySelector(".lang-name")?.textContent,
    row.querySelector(".lang-tag")?.textContent ?? null,
  ]);

type Add = { value: string; hidden: boolean };

const addControl = (doc: Page, form: string) =>
  doc.getElementById(`${form}-add`) as unknown as Add;

/** The languages Add offers, by code. */
const offered = (doc: Page, form: string) =>
  [...doc.querySelectorAll(`#${form}-add option`)]
    .map((option) => option.getAttribute("value"))
    .filter(Boolean);

/** Choose this language from Add, as a person does. */
const add = (doc: Page, form: string, code: string) => {
  addControl(doc, form).value = code;
  doc.getElementById(`${form}-add`)?.dispatchEvent(new window.Event("change"));
};

/** Press a row's button by its label. */
const press = (doc: Page, form: string, label: string) =>
  (
    doc.querySelector(`#${form}-list [aria-label="${label}"]`) as unknown as {
      click(): void;
    }
  ).click();

/** The labels of the buttons a form's list offers. */
const buttons = (doc: Page, form: string) =>
  [...doc.querySelectorAll(`#${form}-list button`)].map((button) =>
    button.getAttribute("aria-label"),
  );

/** The label of the control that has focus. */
const focused = (doc: Page) => doc.activeElement?.getAttribute("aria-label");

/** The real page in a document, where focus can land. */
async function livePage() {
  const doc = await page();
  window.document.body.replaceChildren(
    window.document.importNode(doc.body, true),
  );
  return window.document as unknown as Page;
}

for (const form of FORMS) {
  test(`${form}: the languages are listed in order, the first marked as main`, async () => {
    const doc = await page();

    languageList(doc, form).show(["DE", "EN"]);

    expect(rows(doc, form)).toEqual([
      ["German", "Main"],
      ["English", null],
    ]);
  });

  test(`${form}: choosing from Add adds the language at once and leaves Add ready for another`, async () => {
    const doc = await page();
    const list = languageList(doc, form);
    list.show(["EN"]);

    add(doc, form, "DE");

    expect(list.languages()).toEqual(["EN", "DE"]);
    expect(rows(doc, form)).toEqual([
      ["English", "Main"],
      ["German", null],
    ]);
    expect(addControl(doc, form).value).toBe("");
  });

  test(`${form}: Add doesn't offer a language already chosen`, async () => {
    const doc = await page();
    languageList(doc, form).show(["EN"]);

    add(doc, form, "DE");

    expect(offered(doc, form)).not.toContain("EN");
    expect(offered(doc, form)).not.toContain("DE");
    expect(offered(doc, form)).toContain("AR");
  });

  test(`${form}: Add offers the tested languages first, and drops the group once all are chosen`, async () => {
    const doc = await page();
    const list = languageList(doc, form);
    const groups = () =>
      [...doc.querySelectorAll(`#${form}-add optgroup`)].map((group) =>
        group.getAttribute("label"),
      );

    list.show(["EN"]);
    expect(groups()).toEqual(["Tested", "Untested"]);

    list.show(["EN", "DE", "AR"]);
    expect(groups()).toEqual(["Untested"]);
  });

  test(`${form}: Add goes away at four languages`, async () => {
    const doc = await page();
    const list = languageList(doc, form);

    list.show(["EN", "DE", "AR"]);
    expect(addControl(doc, form).hidden).toBe(false);

    add(doc, form, "FR");
    expect(addControl(doc, form).hidden).toBe(true);
  });

  test(`${form}: a language can be removed, and the next takes its place as main`, async () => {
    const doc = await page();
    const list = languageList(doc, form);
    list.show(["EN", "DE", "AR"]);

    press(doc, form, "Remove English");

    expect(list.languages()).toEqual(["DE", "AR"]);
    expect(rows(doc, form)[0]).toEqual(["German", "Main"]);
  });

  test(`${form}: a removed language is offered again, and Add comes back`, async () => {
    const doc = await page();
    languageList(doc, form).show(["EN", "DE", "AR", "FR"]);

    press(doc, form, "Remove German");

    expect(addControl(doc, form).hidden).toBe(false);
    expect(offered(doc, form)).toContain("DE");
  });

  test(`${form}: the last language can't be removed`, async () => {
    const doc = await page();
    languageList(doc, form).show(["EN"]);

    expect(buttons(doc, form)).toEqual([]);
  });

  test(`${form}: a language moves up past the one before it, and can become main`, async () => {
    const doc = await page();
    const list = languageList(doc, form);
    list.show(["EN", "DE", "AR"]);

    press(doc, form, "Move Arabic up");
    expect(list.languages()).toEqual(["EN", "AR", "DE"]);

    press(doc, form, "Move Arabic up");
    expect(list.languages()).toEqual(["AR", "EN", "DE"]);
    expect(rows(doc, form)[0]).toEqual(["Arabic", "Main"]);
  });

  test(`${form}: the main language has nowhere to move up to`, async () => {
    const doc = await page();
    languageList(doc, form).show(["EN", "DE"]);

    expect(buttons(doc, form)).toEqual([
      "Remove English",
      "Move German up",
      "Remove German",
    ]);
  });

  test(`${form}: a language the picker doesn't offer is held like any other`, async () => {
    const doc = await page();
    const list = languageList(doc, form);
    list.show(["LA", "EN"]);

    press(doc, form, "Move English up");

    expect(list.languages()).toEqual(["EN", "LA"]);
    expect(rows(doc, form)[1]).toEqual(["Latin", null]);
  });

  test(`${form}: focus stays on a language as it moves up`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE", "AR"]);

    press(doc, form, "Move Arabic up");
    expect(focused(doc)).toBe("Move Arabic up");
  });

  test(`${form}: a language that becomes main has no Move up, so focus lands on its Remove`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE"]);

    press(doc, form, "Move German up");
    expect(focused(doc)).toBe("Remove German");
  });

  test(`${form}: after a Remove, focus goes to the next language's Remove`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE", "AR"]);

    press(doc, form, "Remove German");
    expect(focused(doc)).toBe("Remove Arabic");
  });

  test(`${form}: with no next language to go to, focus goes to Add`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE", "AR"]);

    press(doc, form, "Remove Arabic");
    expect(focused(doc)).toBe("Add a language");
  });

  test(`${form}: with one language left, focus goes to Add`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE"]);

    press(doc, form, "Remove English");
    expect(focused(doc)).toBe("Add a language");
  });

  test(`${form}: focus stays on Add for the next language, and moves to the list once Add goes`, async () => {
    const doc = await livePage();
    languageList(doc, form).show(["EN", "DE"]);

    add(doc, form, "AR");
    expect(focused(doc)).toBe("Add a language");

    add(doc, form, "FR");
    expect(focused(doc)).toBe("Remove French");
  });

  test(`${form}: every edit is reported, and drawing the list is not an edit`, async () => {
    const doc = await page();
    let edits = 0;
    const list = languageList(doc, form, () => {
      edits += 1;
    });

    list.show(["EN", "DE"]);
    expect(edits).toBe(0);

    add(doc, form, "AR");
    press(doc, form, "Move Arabic up");
    press(doc, form, "Remove English");
    expect(edits).toBe(3);
  });
}
