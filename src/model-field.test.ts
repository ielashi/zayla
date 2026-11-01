import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { modelField } from "./model-field.ts";

const FORMS = ["prov", "setup-prov"];
const window = new Window();

/** The real page, unrun, so a form that lost its parts fails here. */
async function page() {
  return new window.DOMParser().parseFromString(
    await Bun.file(`${import.meta.dir}/../index.html`).text(),
    "text/html",
  );
}

type Page = Awaited<ReturnType<typeof page>>;

const input = (doc: Page, id: string) =>
  doc.getElementById(id) as unknown as { value: string };

const listOpen = (doc: Page, form: string) =>
  !(doc.getElementById(`${form}-models`) as unknown as { hidden: boolean })
    .hidden;

/** The model the arrow keys are on. */
const highlighted = (doc: Page, form: string) =>
  doc
    .querySelector(`#${form}-models [aria-selected="true"]`)
    ?.getAttribute("data-model");

const fire = (doc: Page, id: string, event: string) =>
  doc.getElementById(id)?.dispatchEvent(new window.Event(event));

const press = (doc: Page, form: string, key: string) => {
  const event = new window.KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
  });
  doc.getElementById(`${form}-model`)?.dispatchEvent(event);
  return event;
};

/** What a form's list shows: each model, with the tag it carries. */
const offers = (doc: Page, form: string) =>
  [...doc.querySelectorAll(`#${form}-models [role="option"]`)].map((o) => [
    o.querySelector(".prov-model-id")?.textContent,
    o.querySelector(".prov-tag")?.textContent ?? null,
  ]);

for (const form of FORMS) {
  test(`${form}: with no Provider saved, OpenRouter's model starts as the Recommended model`, async () => {
    const doc = await page();

    modelField(doc, form).fill("openrouter", "");

    expect(input(doc, `${form}-model`).value).toBe("google/gemini-3.6-flash");
  });

  test(`${form}: a saved model is shown instead of the Recommended model`, async () => {
    const doc = await page();

    modelField(doc, form).fill("openrouter", "qwen/qwen3-vl");

    expect(input(doc, `${form}-model`).value).toBe("qwen/qwen3-vl");
  });

  test(`${form}: a Custom Provider has no Recommended model`, async () => {
    const doc = await page();

    modelField(doc, form).fill("custom", "");

    expect(input(doc, `${form}-model`).value).toBe("");
  });

  test(`${form}: switching to Custom and back takes the Recommended model away and restores it`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("openrouter", "");

    field.switchKind("custom");
    expect(input(doc, `${form}-model`).value).toBe("");

    field.switchKind("openrouter");
    expect(input(doc, `${form}-model`).value).toBe("google/gemini-3.6-flash");
  });

  test(`${form}: switching leaves a typed model alone`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("openrouter", "");
    input(doc, `${form}-model`).value = "qwen/qwen3-vl";

    field.switchKind("custom");
    expect(input(doc, `${form}-model`).value).toBe("qwen/qwen3-vl");

    field.switchKind("openrouter");
    expect(input(doc, `${form}-model`).value).toBe("qwen/qwen3-vl");
  });

  test(`${form}: the note names the Recommended model for OpenRouter and is gone for Custom`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    const note = doc.getElementById(`${form}-recommended`) as unknown as {
      hidden: boolean;
      textContent: string;
    };

    field.fill("openrouter", "qwen/qwen3-vl");
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("google/gemini-3.6-flash");

    field.switchKind("custom");
    expect(note.hidden).toBe(true);
  });

  test(`${form}: the Recommended model is offered first and labelled, the rest in order`, async () => {
    const doc = await page();

    modelField(doc, form).offer([
      "a/first",
      "google/gemini-3.6-flash",
      "z/last",
    ]);

    expect(offers(doc, form)).toEqual([
      ["google/gemini-3.6-flash", "Recommended"],
      ["a/first", null],
      ["z/last", null],
    ]);
  });

  test(`${form}: a listing without the Recommended model labels nothing`, async () => {
    const doc = await page();

    const said = modelField(doc, form).offer(["a/first"]);

    expect(offers(doc, form)).toEqual([["a/first", null]]);
    expect(said).toBe("1 model offered — pick one, or type an id.");
  });

  test(`${form}: changing kind drops the models listed for the old one`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.offer(["a/first"]);

    field.switchKind("custom");

    expect(offers(doc, form)).toEqual([]);
  });

  test(`${form}: a Custom address listing that model neither moves nor labels it`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("custom", "");

    field.offer(["a/first", "google/gemini-3.6-flash"]);

    expect(offers(doc, form)).toEqual([
      ["a/first", null],
      ["google/gemini-3.6-flash", null],
    ]);
  });

  test(`${form}: the note names the model and offers nothing to press`, async () => {
    const doc = await page();
    modelField(doc, form).fill("openrouter", "");

    expect(doc.querySelector(`#${form}-recommended`)?.textContent?.trim()).toBe(
      "Recommended: google/gemini-3.6-flash",
    );
    expect(doc.querySelector(`#${form}-recommended button`)).toBeNull();
  });

  test(`${form}: listing models keeps the field and shows every model under it`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("openrouter", "");

    field.offer(["a/first", "google/gemini-3.6-flash"]);

    expect(input(doc, `${form}-model`).value).toBe("google/gemini-3.6-flash");
    expect(offers(doc, form).length).toBe(2);
    expect(listOpen(doc, form)).toBe(true);
  });

  test(`${form}: choosing a model puts its id in the field and closes the list`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first", "z/last"]);

    (
      doc.querySelector(`#${form}-models [data-model="z/last"]`) as unknown as {
        click(): void;
      }
    ).click();

    expect(input(doc, `${form}-model`).value).toBe("z/last");
    expect(listOpen(doc, form)).toBe(false);
  });

  test(`${form}: typing narrows the list, and an id it doesn't hold can still be typed`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["anthropic/one", "google/two", "z/last"]);

    input(doc, `${form}-model`).value = "GOOGLE";
    fire(doc, `${form}-model`, "input");
    expect(offers(doc, form).map(([id]) => id)).toEqual(["google/two"]);

    input(doc, `${form}-model`).value = "mine/own";
    fire(doc, `${form}-model`, "input");
    expect(listOpen(doc, form)).toBe(false);
    expect(input(doc, `${form}-model`).value).toBe("mine/own");
  });

  test(`${form}: focusing the field shows the whole list again, and leaving closes it`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first", "z/last"]);

    fire(doc, `${form}-model`, "blur");
    expect(listOpen(doc, form)).toBe(false);

    fire(doc, `${form}-model`, "focus");
    expect(offers(doc, form).length).toBe(2);
  });

  test(`${form}: arrows and Enter choose from the list without sending the form`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first", "z/last"]);

    press(doc, form, "ArrowDown");
    press(doc, form, "ArrowDown");
    const enter = press(doc, form, "Enter");

    expect(input(doc, `${form}-model`).value).toBe("z/last");
    expect(enter.defaultPrevented).toBe(true);
  });

  test(`${form}: Enter with nothing highlighted is left to the form`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);

    expect(press(doc, form, "Enter").defaultPrevented).toBe(false);
  });

  test(`${form}: Escape closes an open list before it would close the dialog`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);

    expect(press(doc, form, "Escape").defaultPrevented).toBe(true);
    expect(listOpen(doc, form)).toBe(false);
    expect(press(doc, form, "Escape").defaultPrevented).toBe(false);
  });

  test(`${form}: a model's id is shown as text, whatever it says`, async () => {
    const doc = await page();

    modelField(doc, form).offer(["<img src=x>"]);

    expect(offers(doc, form)).toEqual([["<img src=x>", null]]);
    expect(doc.querySelector(`#${form}-models img`)).toBeNull();
  });

  test(`${form}: clicking the field reopens a list closed with Escape`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);
    press(doc, form, "Escape");

    fire(doc, `${form}-model`, "click");

    expect(listOpen(doc, form)).toBe(true);
  });

  test(`${form}: Escape on an open list goes no further than the field`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);
    let reached = false;
    doc.body.addEventListener("keydown", () => {
      reached = true;
    });

    press(doc, form, "Escape");
    expect(reached).toBe(false);

    press(doc, form, "Escape");
    expect(reached).toBe(true);
  });

  test(`${form}: the arrow keys stay in the list rather than moving the caret`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);

    expect(press(doc, form, "ArrowDown").defaultPrevented).toBe(true);
    expect(press(doc, form, "ArrowUp").defaultPrevented).toBe(true);
  });

  test(`${form}: an arrow key reopens a closed list on its first model`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first", "z/last"]);
    press(doc, form, "Escape");

    press(doc, form, "ArrowDown");
    press(doc, form, "Enter");

    expect(input(doc, `${form}-model`).value).toBe("a/first");
  });

  test(`${form}: up from nothing highlighted lands on the last model, and down wraps to the first`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first", "m/middle", "z/last"]);

    press(doc, form, "ArrowUp");
    expect(highlighted(doc, form)).toBe("z/last");

    press(doc, form, "ArrowDown");
    expect(highlighted(doc, form)).toBe("a/first");
  });

  test(`${form}: models listed for one kind don't come back after switching`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.offer(["a/first"]);

    field.switchKind("custom");
    fire(doc, `${form}-model`, "focus");

    expect(offers(doc, form)).toEqual([]);
  });

  test(`${form}: forgotten models don't come back on focus`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.offer(["a/first"]);

    field.forgetOffers();
    fire(doc, `${form}-model`, "focus");

    expect(offers(doc, form)).toEqual([]);
  });

  test(`${form}: pressing the list keeps focus in the field`, async () => {
    const doc = await page();
    modelField(doc, form).offer(["a/first"]);
    const event = new window.MouseEvent("mousedown", { cancelable: true });

    doc.getElementById(`${form}-models`)?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test(`${form}: the field tells assistive tech whether the list is open and which model is highlighted`, async () => {
    const doc = await page();
    const field = doc.getElementById(`${form}-model`);
    modelField(doc, form).offer(["a/first"]);
    expect(field?.getAttribute("aria-expanded")).toBe("true");

    press(doc, form, "ArrowDown");
    const option = doc.querySelector(`#${form}-models [data-model="a/first"]`);
    expect(field?.getAttribute("aria-activedescendant")).toBe(option?.id);

    press(doc, form, "Escape");
    expect(field?.getAttribute("aria-expanded")).toBe("false");
  });
}
