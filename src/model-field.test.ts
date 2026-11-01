import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { modelField } from "./model-field.ts";

const FORMS = ["prov", "setup-prov"];

/** The real page, unrun, so a form that lost its parts fails here. */
async function page() {
  const window = new Window();
  return new window.DOMParser().parseFromString(
    await Bun.file(`${import.meta.dir}/../index.html`).text(),
    "text/html",
  );
}

type Page = Awaited<ReturnType<typeof page>>;

const input = (doc: Page, id: string) =>
  doc.getElementById(id) as unknown as { value: string };

/** What a form's list suggests: each model, with the label it carries. */
const offers = (doc: Page, form: string) =>
  [...doc.querySelectorAll(`#${form}-models option`)].map((o) => [
    o.getAttribute("value"),
    o.getAttribute("label"),
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

  test(`${form}: the note's button puts the Recommended model back`, async () => {
    const doc = await page();
    modelField(doc, form).fill("openrouter", "qwen/qwen3-vl");

    (
      doc.getElementById(`${form}-recommended-use`) as unknown as {
        click(): void;
      }
    ).click();

    expect(input(doc, `${form}-model`).value).toBe("google/gemini-3.6-flash");
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

  test(`${form}: listing models empties a field left on the Recommended model, so all of them show`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("openrouter", "");

    field.offer(["a/first", "google/gemini-3.6-flash"]);

    expect(input(doc, `${form}-model`).value).toBe("");
  });

  test(`${form}: listing models leaves a typed model, and an empty listing leaves the field`, async () => {
    const doc = await page();
    const field = modelField(doc, form);
    field.fill("openrouter", "");

    field.offer([]);
    expect(input(doc, `${form}-model`).value).toBe("google/gemini-3.6-flash");

    input(doc, `${form}-model`).value = "qwen/qwen3-vl";
    field.offer(["a/first"]);
    expect(input(doc, `${form}-model`).value).toBe("qwen/qwen3-vl");
  });
}
