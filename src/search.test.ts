import { expect, test } from "bun:test";
import { searchDocuments, sortAfterTyping, titleOf } from "./search.ts";
import type { ApiDocument, ApiSearchHit } from "./shared.ts";

/** A minimal enriched document; overrides supply whatever the case is about. */
function doc(over: Partial<ApiDocument> = {}): ApiDocument {
  return {
    hash: over.hash ?? "h0",
    filename: "scan.pdf",
    mime: "application/pdf",
    ext: "pdf",
    bytes: 1000,
    addedAt: "2026-01-01T00:00:00.000Z",
    status: "enriched",
    title: null,
    people: [],
    date: null,
    languages: [],
    keywords: [],
    summary: null,
    ref: [],
    sender: null,
    receiver: null,
    deadlines: [],
    pages: 1,
    ...over,
  };
}

const dated = (hash: string, date: string | null) => doc({ hash, date });
const hashes = (ds: ApiDocument[]) => ds.map((d) => d.hash);

/** What the server answered for a search: these hashes, in Best match order. */
const hitsOf = (...hs: string[]): ApiSearchHit[] =>
  hs.map((hash) => ({ hash, tier: 1, snippet: null }));

// ---- what a search shows -------------------------------------------------

test("with no query, the whole Library shows", () => {
  const docs = [doc({ hash: "a" }), doc({ hash: "b" })];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "new" }))).toEqual([
    "a",
    "b",
  ]);
});

test("a search shows only the Documents the server found", () => {
  const docs = [doc({ hash: "a" }), doc({ hash: "b" }), doc({ hash: "c" })];
  const out = searchDocuments(docs, { hits: hitsOf("c", "a"), sort: "best" });
  expect(hashes(out)).toEqual(["c", "a"]);
});

test("a hit for a Document the gallery doesn't hold is skipped", () => {
  const docs = [doc({ hash: "a" })];
  const out = searchDocuments(docs, {
    hits: hitsOf("gone", "a"),
    sort: "best",
  });
  expect(hashes(out)).toEqual(["a"]);
});

test("a chosen sort reorders a search's results, setting Best match aside", () => {
  const docs = [dated("old", "2020-01-01"), dated("new", "2024-01-01")];
  const hits = hitsOf("old", "new");
  expect(hashes(searchDocuments(docs, { hits, sort: "best" }))).toEqual([
    "old",
    "new",
  ]);
  expect(hashes(searchDocuments(docs, { hits, sort: "new" }))).toEqual([
    "new",
    "old",
  ]);
});

test("with no query, Best match falls back to Newest", () => {
  const docs = [dated("old", "2020-01-01"), dated("new", "2024-01-01")];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "best" }))).toEqual([
    "new",
    "old",
  ]);
});

// ---- sorting as the box is typed in --------------------------------------

test("typing into an empty box switches to Best match, and clearing it back to Newest", () => {
  expect(sortAfterTyping("", "t", "new")).toBe("best");
  expect(sortAfterTyping("", "t", "old")).toBe("best");
  expect(sortAfterTyping("tax", "", "size")).toBe("new");
  expect(sortAfterTyping("tax", "  ", "best")).toBe("new");
});

test("a sort chosen during a search holds while the query changes", () => {
  expect(sortAfterTyping("tax", "tax z", "old")).toBe("old");
  expect(sortAfterTyping("tax", "tax z", "best")).toBe("best");
  expect(sortAfterTyping("", " ", "size")).toBe("size");
});

// ---- sorting -------------------------------------------------------------

test("newest and oldest order by the document's own date", () => {
  const docs = [dated("b", "2022-05-01"), dated("a", "2024-01-01")];
  const by = (sort: "new" | "old") =>
    hashes(searchDocuments(docs, { hits: null, sort }));
  expect(by("new")).toEqual(["a", "b"]);
  expect(by("old")).toEqual(["b", "a"]);
});

test("undated documents sink to the bottom in both directions", () => {
  const docs = [
    dated("none", null),
    dated("old", "2020-01-01"),
    dated("new", "2024-01-01"),
  ];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "new" }))).toEqual([
    "new",
    "old",
    "none",
  ]);
  expect(hashes(searchDocuments(docs, { hits: null, sort: "old" }))).toEqual([
    "old",
    "new",
    "none",
  ]);
});

test("recently added sorts by import time, not document date", () => {
  const docs = [
    doc({ hash: "a", date: "2024-01-01", addedAt: "2026-01-01T00:00:00.000Z" }),
    doc({ hash: "b", date: "2020-01-01", addedAt: "2026-02-01T00:00:00.000Z" }),
  ];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "added" }))).toEqual([
    "b",
    "a",
  ]);
});

test("name sorts by title, falling back to filename when untitled", () => {
  const docs = [
    doc({ hash: "z", title: "Zebra" }),
    doc({ hash: "a", title: null, filename: "alpha.pdf" }),
  ];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "name" }))).toEqual([
    "a",
    "z",
  ]);
});

test("size sorts largest first", () => {
  const docs = [doc({ hash: "s", bytes: 10 }), doc({ hash: "l", bytes: 999 })];
  expect(hashes(searchDocuments(docs, { hits: null, sort: "size" }))).toEqual([
    "l",
    "s",
  ]);
});

test("session-added documents pin to the top in drop order, ahead of the sort", () => {
  const docs = [
    dated("old-but-newest-date", "2026-01-01"),
    dated("dropped-first", null),
    dated("dropped-second", null),
  ];
  const out = searchDocuments(docs, {
    hits: null,
    sort: "new",
    recent: ["dropped-first", "dropped-second"],
  });
  expect(hashes(out)).toEqual([
    "dropped-first",
    "dropped-second",
    "old-but-newest-date",
  ]);
});

test("during a search, session-added documents are not pinned", () => {
  const docs = [dated("pinned", null), dated("other", "2026-01-01")];
  const out = searchDocuments(docs, {
    hits: hitsOf("other", "pinned"),
    sort: "new",
    recent: ["pinned"],
  });
  expect(hashes(out)).toEqual(["other", "pinned"]);
});

test("searching does not mutate the caller's array", () => {
  const docs = [dated("b", "2020-01-01"), dated("a", "2024-01-01")];
  searchDocuments(docs, { hits: null, sort: "new" });
  expect(hashes(docs)).toEqual(["b", "a"]);
});

// ---- titleOf -------------------------------------------------------------

test("titleOf prefers the enriched title and falls back to the filename", () => {
  expect(titleOf(doc({ title: "Lease", filename: "scan.pdf" }))).toBe("Lease");
  expect(titleOf(doc({ title: null, filename: "scan.pdf" }))).toBe("scan.pdf");
  expect(titleOf(doc({ title: "", filename: "scan.pdf" }))).toBe("scan.pdf");
});
