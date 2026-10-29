import { expect, test } from "bun:test";
import {
  LANGUAGE_CODES,
  languageName,
  OFFERED_LANGUAGES,
  readingLanguagesFrom,
  TESTED_LANGUAGES,
} from "./languages.ts";

test("every offered language is an ISO 639-1 language with a name, offered once", () => {
  for (const code of OFFERED_LANGUAGES) {
    expect(LANGUAGE_CODES).toContain(code);
    expect(languageName(code)).not.toBe(code);
  }
  expect(new Set(OFFERED_LANGUAGES).size).toBe(OFFERED_LANGUAGES.length);
});

test("the tested languages are English, German and Arabic, all offered", () => {
  expect([...TESTED_LANGUAGES]).toEqual(["EN", "DE", "AR"]);
  for (const code of TESTED_LANGUAGES)
    expect(OFFERED_LANGUAGES).toContain(code);
});

test("a language the pickers don't offer is still accepted", () => {
  expect(OFFERED_LANGUAGES).not.toContain("LA");
  expect(readingLanguagesFrom(["la"])).toEqual({ languages: ["LA"] });
});
