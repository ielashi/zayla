import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  closeLibrary,
  getDocument,
  type Library,
  listDocuments,
  openLibrary,
  updateEnrichment,
} from "./db.ts";
import { listEntities } from "./entities.ts";
import { deleteFile, importFile } from "./ingest.ts";
import {
  derivedDir,
  documentFilePath,
  objectPath,
  transcriptionPath,
} from "./library.ts";
import { writeTranscription } from "./transcription.ts";

const TMP = `/tmp/dm-delete-test-${process.pid}`;
const FIXDIR = `/tmp/dm-delete-fix-${process.pid}`;
const FIXTURE = join(FIXDIR, "sample.pdf");

beforeAll(async () => {
  await mkdir(FIXDIR, { recursive: true });
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

test("delete removes the catalog row, the original, and the derived dir", async () => {
  const { hash } = await importFile(library, FIXTURE);
  const obj = objectPath(TMP, hash, "pdf");
  const derived = derivedDir(TMP, hash);
  await mkdir(derived, { recursive: true });
  await writeFile(join(derived, "thumb.jpg"), "x");

  const res = await deleteFile(library, hash);

  expect(res.status).toBe("deleted");
  expect(res.filename).toBe("sample.pdf");
  expect(await Bun.file(obj).exists()).toBe(false);
  expect(await Bun.file(join(derived, "thumb.jpg")).exists()).toBe(false);

  const lib = openLibrary(TMP);
  try {
    expect(getDocument(lib, hash)).toBeNull();
    expect(listDocuments(lib).length).toBe(0);
  } finally {
    closeLibrary(lib);
  }
});

test("delete on a missing hash throws (no silent no-op on a typo)", async () => {
  await importFile(library, FIXTURE); // ensure the library tree exists
  expect(deleteFile(library, "0".repeat(64))).rejects.toThrow(
    /no document with hash/,
  );
});

test("delete is idempotent at the file level but errors on an unknown hash", async () => {
  const { hash } = await importFile(library, FIXTURE);
  await rm(objectPath(TMP, hash, "pdf"), { force: true }); // object already gone

  await deleteFile(library, hash); // should still succeed — missing object is not an error

  const lib = openLibrary(TMP);
  try {
    expect(getDocument(lib, hash)).toBeNull();
  } finally {
    closeLibrary(lib);
  }
});

test("a fresh import after delete is not treated as a dedupe", async () => {
  const a = await importFile(library, FIXTURE);
  await deleteFile(library, a.hash);
  const b = await importFile(library, FIXTURE);
  expect(b.deduped).toBe(false);
  expect(b.hash).toBe(a.hash);
});

test("an import of the same file made while a Delete is under way is kept whole", async () => {
  const { hash } = await importFile(library, FIXTURE);
  // Enough Derived artifacts that removing them takes a while.
  const derived = derivedDir(TMP, hash);
  await mkdir(derived, { recursive: true });
  await Promise.all(
    Array.from({ length: 2000 }, (_, i) =>
      writeFile(join(derived, `page-${i}.jpg`), "x"),
    ),
  );

  const [, again] = await Promise.all([
    deleteFile(library, hash),
    importFile(library, FIXTURE),
  ]);

  expect(again.deduped).toBe(false);
  expect(getDocument(library, hash)).not.toBeNull();
  expect(await Bun.file(documentFilePath(TMP, hash)).exists()).toBe(true);
  expect(await Bun.file(objectPath(TMP, hash, "pdf")).exists()).toBe(true);
  const after = openLibrary(TMP);
  try {
    expect(getDocument(after, hash)).not.toBeNull();
  } finally {
    closeLibrary(after);
  }
});

test("delete removes the document's Appearances", async () => {
  const { hash } = await importFile(library, FIXTURE);
  updateEnrichment(
    library,
    hash,
    {
      texts: {},
      people: [],
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
      receiver: { organization: "", person: "" },
      deadlines: [],
      date: null,
      languages: [],
      keywords: [],
      ref: [],
    },
    { textSource: "vision", baseUrl: "http://mock.test/v1", model: "mock" },
  );
  expect(listEntities(library).length).toBe(2);

  await deleteFile(library, hash);

  expect(listEntities(library)).toEqual([]);
  const after = openLibrary(TMP);
  try {
    expect(listEntities(after)).toEqual([]);
  } finally {
    closeLibrary(after);
  }
});

test("delete removes the transcription and the document's file", async () => {
  const { hash } = await importFile(library, FIXTURE);
  writeTranscription(TMP, hash, "Rechnung Nr. 4711");

  await deleteFile(library, hash);

  expect(await Bun.file(transcriptionPath(TMP, hash)).exists()).toBe(false);
  expect(await Bun.file(documentFilePath(TMP, hash)).exists()).toBe(false);
});
