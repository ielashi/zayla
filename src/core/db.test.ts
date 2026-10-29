import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  type CatalogFields,
  closeLibrary,
  findDocumentsByPrefix,
  insertDocument,
  openLibrary,
} from "./db.ts";

const TMP = `/tmp/dm-db-test-${process.pid}`;

const doc = (hash: string): CatalogFields => ({
  hash,
  ext: "pdf",
  mime: "application/pdf",
  filename: `${hash.slice(0, 6)}.pdf`,
  bytes: 1,
  status: "imported",
  addedAt: new Date().toISOString(),
});

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test("findDocumentsByPrefix: full hash, unique prefix, ambiguous prefix, no match", () => {
  const lib = openLibrary(TMP);
  try {
    insertDocument(lib, doc("abc111"));
    insertDocument(lib, doc("abc222"));
    insertDocument(lib, doc("def333"));

    expect(findDocumentsByPrefix(lib, "abc111").map((d) => d.hash)).toEqual([
      "abc111",
    ]); // exact
    expect(findDocumentsByPrefix(lib, "def").map((d) => d.hash)).toEqual([
      "def333",
    ]); // unique prefix
    expect(findDocumentsByPrefix(lib, "abc").map((d) => d.hash)).toEqual([
      "abc111",
      "abc222",
    ]); // ambiguous
    expect(findDocumentsByPrefix(lib, "zzz")).toEqual([]); // no match
  } finally {
    closeLibrary(lib);
  }
});
