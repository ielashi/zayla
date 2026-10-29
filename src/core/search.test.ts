import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  closeLibrary,
  deleteDocument,
  getDocument,
  insertDocument,
  type Library,
  openLibrary,
} from "./db.ts";
import type { EnrichedMetadata } from "./enrich.ts";
import { enrichDocument } from "./enrich.ts";
import { documentFilePath, searchIndexPath } from "./library.ts";
import { searchLibrary } from "./search.ts";

/**
 * The search index is a Derived artifact: whatever becomes of it, opening the
 * Library gives search back the same Documents, ranked the same way.
 */

const TMP = `/tmp/dm-core-search-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const EMPTY: EnrichedMetadata = {
  texts: {},
  people: [],
  sender: { organization: "", person: "" },
  receiver: { organization: "", person: "" },
  deadlines: [],
  date: null,
  languages: [],
  keywords: [],
  ref: [],
};

/** File a Document and read it as a model would have, Transcription and all. */
async function filed(
  lib: Library,
  hash: string,
  filename: string,
  reading: Partial<EnrichedMetadata> | null,
  transcription: string | null = null,
): Promise<void> {
  insertDocument(lib, {
    hash,
    ext: "pdf",
    mime: "application/pdf",
    filename,
    bytes: 1,
    status: "imported",
    addedAt: `2026-01-0${hash[0]}T00:00:00.000Z`,
  });
  const doc = getDocument(lib, hash);
  if (!doc || !reading) return;
  await enrichDocument(lib, doc, {
    baseUrl: "http://mock.test/v1",
    model: "mock",
    async enrich() {
      return {
        meta: { ...EMPTY, ...reading },
        transcription,
        finishReason: "stop",
        costUsd: null,
      };
    },
  });
}

const QUERIES = ["nordhaus", "miet", "ag", "rechnung 4711", "scan.pdf"];

/** What each query finds, in order, with its tier and snippet. */
const results = (lib: Library) =>
  QUERIES.map((q) => ({ q, hits: searchLibrary(lib, q) }));

async function seed(): Promise<ReturnType<typeof results>> {
  const lib = openLibrary(TMP, { writer: "test" });
  try {
    await filed(lib, `1${"0".repeat(63)}`, "lease.pdf", {
      texts: { EN: { title: "Lease with Nordhaus AG", summary: "A lease." } },
      sender: { organization: "Nordhaus AG", person: "" },
      date: "2026-01-01",
      keywords: ["mietvertrag"],
    });
    await filed(
      lib,
      `2${"0".repeat(63)}`,
      "invoice.pdf",
      {
        texts: { DE: { title: "Rechnung", summary: "Eine Rechnung." } },
        date: "2026-02-01",
      },
      "Rechnung Nr. 4711\nVermieterin: Nordhaus AG, Mietzins fällig",
    );
    await filed(lib, `3${"0".repeat(63)}`, "scan.pdf", null);
    const before = results(lib);
    // Every query finds something, so the comparison below means something.
    for (const { hits } of before) expect(hits.length).toBeGreaterThan(0);
    return before;
  } finally {
    closeLibrary(lib);
  }
}

test("deleting the search index leaves search finding and ranking the same Documents", async () => {
  const before = await seed();
  for (const suffix of ["", "-wal", "-shm"])
    await rm(`${searchIndexPath(TMP)}${suffix}`, { force: true });

  const lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(results(lib)).toEqual(before);
  } finally {
    closeLibrary(lib);
  }
});

test("an index stamped with another version is rebuilt, and search finds and ranks the same Documents", async () => {
  const before = await seed();
  // An index from another version: its stamp differs, and what it holds can't
  // be trusted — here, nothing at all.
  const raw = new Database(searchIndexPath(TMP));
  raw.exec("DELETE FROM search_index; PRAGMA user_version = 999;");
  raw.close();

  const lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(results(lib)).toEqual(before);
  } finally {
    closeLibrary(lib);
  }
});

test("search finds the same Documents after the Library is closed and reopened", async () => {
  const before = await seed();

  const lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(results(lib)).toEqual(before);
  } finally {
    closeLibrary(lib);
  }
});

/** The search index's file as it stands: its inode and contents, or null. */
async function indexFile(): Promise<{ ino: number; bytes: string } | null> {
  const file = Bun.file(searchIndexPath(TMP));
  if (!(await file.exists())) return null;
  return {
    ino: (await file.stat()).ino,
    bytes: Bun.hash(await file.arrayBuffer()).toString(),
  };
}

test("a Document whose file changed without the index hearing of it is found by what its file says", async () => {
  await seed();
  // As if the process had died between writing document.yaml and updating
  // the index: the file says one thing, the index another.
  const hash = `1${"0".repeat(63)}`;
  const path = documentFilePath(TMP, hash);
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replaceAll("Nordhaus", "Sudhaus"));

  const lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(searchLibrary(lib, "sudhaus").map((h) => h.hash)).toEqual([hash]);
    expect(searchLibrary(lib, "lease nordhaus")).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("an index that outlived a Library restored from an older copy is brought in step with it", async () => {
  const before = await seed();
  const index = await Bun.file(searchIndexPath(TMP)).arrayBuffer();
  // The Library goes on: a Document is filed, another Deleted.
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    await filed(lib, `4${"0".repeat(63)}`, "deed.pdf", {
      texts: { EN: { title: "Deed of Sale", summary: "A deed." } },
    });
    deleteDocument(lib, `3${"0".repeat(63)}`);
  } finally {
    closeLibrary(lib);
  }
  // Then derived/ comes back from before, beside the Library as it is now.
  await Bun.write(searchIndexPath(TMP), index);

  lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(searchLibrary(lib, "deed").map((h) => h.hash)).toEqual([
      `4${"0".repeat(63)}`,
    ]);
    expect(searchLibrary(lib, "scan.pdf")).toEqual([]);
    // The Documents left alone are found as before.
    expect(results(lib)[0]).toEqual(before[0]);
  } finally {
    closeLibrary(lib);
  }
});

test("a reader never deletes or rebuilds the index, and still finds the same Documents", async () => {
  const before = await seed();

  // Missing: the reader searches without writing one.
  for (const suffix of ["", "-wal", "-shm"])
    await rm(`${searchIndexPath(TMP)}${suffix}`, { force: true });
  let reader = openLibrary(TMP);
  try {
    expect(results(reader)).toEqual(before);
  } finally {
    closeLibrary(reader);
  }
  expect(await indexFile()).toBeNull();

  // Stamped with another version, under a server that has it open: the
  // reader leaves it where it is.
  const server = openLibrary(TMP, { writer: "server" });
  try {
    const raw = new Database(searchIndexPath(TMP));
    raw.exec("PRAGMA user_version = 999;");
    raw.close();
    const stale = await indexFile();

    reader = openLibrary(TMP);
    try {
      expect(results(reader)).toEqual(before);
    } finally {
      closeLibrary(reader);
    }
    expect(await indexFile()).toEqual(stale);
    expect(results(server)).toEqual(before);
  } finally {
    closeLibrary(server);
  }
});

test("a reader of an index in step finds the same Documents and leaves the file as it was", async () => {
  const before = await seed();
  const index = await indexFile();

  const reader = openLibrary(TMP);
  try {
    expect(results(reader)).toEqual(before);
  } finally {
    closeLibrary(reader);
  }
  expect(await indexFile()).toEqual(index);
});
