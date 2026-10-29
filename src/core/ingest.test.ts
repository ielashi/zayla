import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  closeLibrary,
  getDocument,
  type Library,
  listDocuments,
  openLibrary,
} from "./db.ts";
import { importFile } from "./ingest.ts";
import { objectPath } from "./library.ts";
import { readTranscriptionSync, writeTranscription } from "./transcription.ts";

const TMP = `/tmp/dm-test-${process.pid}`; // the library under test
const FIXDIR = `/tmp/dm-fix-${process.pid}`; // self-contained fixture — no committed files
const FIXTURE = join(FIXDIR, "sample.pdf");

beforeAll(async () => {
  await mkdir(FIXDIR, { recursive: true });
  // Real "%PDF" magic bytes so content-based mime sniffing has something to detect.
  await Bun.write(FIXTURE, "%PDF-1.4\n% minimal test fixture\n");
});
afterAll(async () => {
  await rm(FIXDIR, { recursive: true, force: true });
});

// The Library under test, for the imports and Deletes a test makes.
let library: Library;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
  library = openLibrary(TMP);
});
afterEach(async () => {
  closeLibrary(library);
  await rm(TMP, { recursive: true, force: true });
});

test("imports a file, stores the original, and catalogs it", async () => {
  const res = await importFile(library, FIXTURE);

  expect(res.deduped).toBe(false);
  expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(await Bun.file(objectPath(TMP, res.hash, "pdf")).exists()).toBe(true);

  const lib = openLibrary(TMP);
  try {
    const docs = listDocuments(lib);
    expect(docs.length).toBe(1);
    expect(docs[0]?.filename).toBe("sample.pdf");
    expect(docs[0]?.bytes).toBeGreaterThan(0);
  } finally {
    closeLibrary(lib);
  }
});

test("hash is stable and re-importing the same content dedupes", async () => {
  const a = await importFile(library, FIXTURE);
  const b = await importFile(library, FIXTURE);

  expect(b.hash).toBe(a.hash);
  expect(b.deduped).toBe(true);

  const lib = openLibrary(TMP);
  try {
    expect(listDocuments(lib).length).toBe(1);
  } finally {
    closeLibrary(lib);
  }
});

test("mime is sniffed from content, not just the extension", async () => {
  const res = await importFile(library, FIXTURE);

  const lib = openLibrary(TMP);
  try {
    expect(getDocument(lib, res.hash)?.mime).toBe("application/pdf");
  } finally {
    closeLibrary(lib);
  }
});

test("re-import restores an object deleted out of band", async () => {
  const res = await importFile(library, FIXTURE);
  const objPath = objectPath(TMP, res.hash, "pdf");
  await rm(objPath, { force: true });
  expect(await Bun.file(objPath).exists()).toBe(false);

  const again = await importFile(library, FIXTURE);

  expect(again.deduped).toBe(true);
  expect(await Bun.file(objPath).exists()).toBe(true); // self-healed
});

test("rejects a path that is not a regular file", async () => {
  await importFile(library, FIXTURE); // create the library tree
  expect(importFile(library, FIXDIR)).rejects.toThrow(/not a file/);
  expect(
    importFile(library, join(FIXDIR, "does-not-exist.pdf")),
  ).rejects.toThrow(/file not found/);
});

test("a second import of a file still in flight leaves the first one's Transcription alone", async () => {
  const imports = [importFile(library, FIXTURE), importFile(library, FIXTURE)];
  const { hash } = await Promise.race(imports);
  // Read as soon as it was filed, while the other import is still going.
  writeTranscription(TMP, hash, "Rechnung Nr. 4711");

  const done = await Promise.all(imports);
  expect(done.filter((d) => !d.deduped)).toHaveLength(1);
  expect(readTranscriptionSync(TMP, hash)).toBe("Rechnung Nr. 4711");
});
