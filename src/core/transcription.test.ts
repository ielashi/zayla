import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readTranscription, writeTranscription } from "./transcription.ts";

const TMP = `/tmp/dm-transcription-test-${process.pid}`;
const HASH = "a".repeat(64);

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test("a transcription reads back exactly as written, line breaks and all", async () => {
  const text = "Rechnung Nr. 4711\n\nBetrag: 129,00 EUR\n[illegible]";

  writeTranscription(TMP, HASH, text);

  expect(await readTranscription(TMP, HASH)).toBe(text);
});

test("reading a document that was never transcribed yields null, not an error", async () => {
  expect(await readTranscription(TMP, "b".repeat(64))).toBeNull();
});

test("re-transcribing replaces the text", async () => {
  writeTranscription(TMP, HASH, "first reading");

  writeTranscription(TMP, HASH, "second reading");

  expect(await readTranscription(TMP, HASH)).toBe("second reading");
});
