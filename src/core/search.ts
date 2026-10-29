import { Database } from "bun:sqlite";
import { rmSync, statSync } from "node:fs";
import type { ApiSearchHit, SearchTier, Snippet } from "../shared.ts";
import type { DocumentRecord, Library } from "./db.ts";
import { searchIndexPath, transcriptionPath } from "./library.ts";
import { readTranscriptionSync } from "./transcription.ts";

/**
 * Searching the Library: which Documents a typed query finds, over everything
 * Zayla worked out about them, Transcription included.
 *
 * The search index is a Derived artifact at `derived/search.db`, built from the
 * Documents and their Transcription files. It is kept in step by the three
 * writes that change what a Document can be found by — filing it, reading it,
 * Deleting it — and built whole whenever the Library's writer opens it without
 * one, or with one built by a different version of this code. Each entry
 * carries a fingerprint of what it was built from, so an entry that fell out of
 * step with its Document — a crash between the two writes, a Library restored
 * beside a newer index — is found and built again when the Library is opened.
 * It holds nothing that isn't already elsewhere, so losing it loses nothing,
 * and nothing but this module reads or writes it.
 *
 * Only the Library's writer changes the file. A handle that only reads works
 * on a private copy in memory: the file's, brought in step with the Documents
 * it read, or one built from them when the file is missing or out of date.
 *
 * It is the one SQLite database the Library has, and this the only module
 * that opens one.
 */

/** The open search index, as the Library handle holds it. */
export type SearchIndex = Database;

/**
 * The shape of what the index holds. Change it whenever what is indexed, or
 * how, changes: every Library's index is then rebuilt the next time it is
 * opened, so no index ever needs migrating.
 */
export const SEARCH_INDEX_VERSION = 2;

/**
 * Text as search compares it: lowercased, with accents and other combining
 * marks dropped, one character at a time. Folding per character rather than per
 * string is what lets a match in folded text be traced back to the passage it
 * came from (see `snippetOf`).
 */
function foldChar(c: string): string {
  return c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export const fold = (s: string): string => Array.from(s, foldChar).join("");

/** A query's terms, folded: whitespace-separated, all of which must match. */
const termsOf = (query: string): string[] =>
  fold(query).split(/\s+/).filter(Boolean);

/** The indexed row's columns, ordered as the tiers rank them. */
type IndexRow = { card: string; reading: string; transcription: string };

const partyText = (p: DocumentRecord["sender"]): string =>
  p ? [p.organization, p.person].filter(Boolean).join(" ") : "";

const join = (parts: (string | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

/**
 * A Document as the index holds it, with its titles and summaries in every
 * language they were written in — those of a language its user no longer
 * reads in included, so it is still found by them.
 */
function indexRowOf(root: string, doc: DocumentRecord): IndexRow {
  const texts = Object.values(doc.texts);
  return {
    card: fold(
      join([
        join(texts.map((t) => t.title)),
        partyText(doc.sender),
        partyText(doc.receiver),
      ]),
    ),
    reading: fold(
      join([
        (doc.people ?? []).join(" "),
        join(texts.map((t) => t.summary)),
        (doc.keywords ?? []).join(" "),
        doc.filename,
      ]),
    ),
    transcription: fold(readTranscriptionSync(root, doc.hash)),
  };
}

/**
 * A short digest of everything a Document's entry is built from: the fields
 * `indexRowOf` reads, and the size and time of its Transcription file, which
 * is written beside it rather than in it. Cheap enough to work out for every
 * Document when the Library opens, without reading any Transcription.
 */
function fingerprintOf(root: string, doc: DocumentRecord): string {
  const t = statSync(transcriptionPath(root, doc.hash), {
    throwIfNoEntry: false,
  });
  return Bun.hash(
    JSON.stringify([
      Object.values(doc.texts).map((text) => [text.title, text.summary]),
      partyText(doc.sender),
      partyText(doc.receiver),
      doc.people,
      doc.keywords,
      doc.filename,
      t ? [t.size, t.mtimeMs] : null,
    ]),
  ).toString(36);
}

/** The index's own version stamp: the SEARCH_INDEX_VERSION that built it. */
const stampOf = (index: Database): number =>
  (index.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;

/**
 * Open the search index of the Library at `root`, whose Documents are these.
 *
 * The Library's writer (`writer`) owns the file. An index missing, unreadable,
 * or stamped with a version other than this code's, is deleted and built
 * again from the Documents; an interrupted build leaves no stamp, so it is
 * built again next time. An index of this version has every entry whose
 * fingerprint differs from its Document's built again, and every entry whose
 * Document is gone dropped.
 *
 * A handle that only reads never deletes, builds or writes the file, which the
 * server may have open: it works on a private copy in memory instead (see
 * `openPrivately`).
 *
 * The trigram tokenizer is what keeps matching by substring — "miet" reaching
 * "Mietvertrag" — rather than by whole word. Its own `remove_diacritics` option
 * is not used: the text is folded here instead, by `fold`, on the way in and on
 * the query alike, so the index and the scan that bypasses it for short terms
 * (see `searchLibrary`) cannot disagree about what matches what.
 */
export function openSearchIndex(
  root: string,
  documents: Map<string, DocumentRecord>,
  writer: boolean,
): Database {
  if (!writer) return openPrivately(root, documents);
  const path = searchIndexPath(root);
  const index = openCurrent(path);
  if (index) {
    index.exec("PRAGMA journal_mode = WAL;");
    catchUp(index, root, documents);
    return index;
  }
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${path}${suffix}`, { force: true });
  const fresh = new Database(path);
  fresh.exec("PRAGMA journal_mode = WAL;");
  build(fresh, root, documents);
  return fresh;
}

/**
 * The index file at `path` when it can be opened and was built by this
 * version of the code; null when it is missing, unreadable or another
 * version's.
 */
function openCurrent(
  path: string,
  options: { readonly?: boolean } = {},
): Database | null {
  let index: Database | null = null;
  try {
    index = new Database(path, { create: false, ...options });
    if (stampOf(index) === SEARCH_INDEX_VERSION) return index;
  } catch {
    // Missing, or not a database: as good as another version's.
  }
  index?.close();
  return null;
}

/**
 * A private index in memory for a handle that only reads: a copy of the file
 * when it is this version's, brought in step with the Documents this handle
 * read, or else one built from them. Nothing it does reaches the file.
 */
function openPrivately(
  root: string,
  documents: Map<string, DocumentRecord>,
): Database {
  const disk = openCurrent(searchIndexPath(root), { readonly: true });
  if (disk) {
    try {
      const image = disk.serialize();
      // A copy in memory cannot use a write-ahead log: mark the image as
      // using the rollback journal (the file format bytes) before loading it.
      image[18] = 1;
      image[19] = 1;
      const copy = Database.deserialize(image);
      catchUp(copy, root, documents);
      return copy;
    } catch {
      // Unreadable after all: built afresh below.
    } finally {
      disk.close();
    }
  }
  const memory = new Database(":memory:");
  build(memory, root, documents);
  return memory;
}

/** Build the index whole into an empty database, stamping it last. */
function build(
  index: Database,
  root: string,
  documents: Map<string, DocumentRecord>,
): void {
  index.transaction(() => {
    index.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        hash UNINDEXED, card, reading, transcription, tokenize = 'trigram'
      );
      CREATE TABLE indexed (
        hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    for (const doc of documents.values()) insertRow(index, root, doc);
    index.exec(`PRAGMA user_version = ${SEARCH_INDEX_VERSION};`);
  })();
}

/**
 * Bring an index of this version in step with the Documents: build again
 * every entry whose fingerprint isn't its Document's, and drop every entry
 * whose Document has gone. Only what differs is touched, so an index already
 * in step costs a fingerprint per Document and no Transcription read.
 */
function catchUp(
  index: Database,
  root: string,
  documents: Map<string, DocumentRecord>,
): void {
  const indexed = new Map(
    (
      index.query("SELECT hash, fingerprint FROM indexed").all() as {
        hash: string;
        fingerprint: string;
      }[]
    ).map((r) => [r.hash, r.fingerprint]),
  );
  const stale = [...documents.values()].filter(
    (doc) => indexed.get(doc.hash) !== fingerprintOf(root, doc),
  );
  const gone = [...indexed.keys()].filter((hash) => !documents.has(hash));
  if (stale.length === 0 && gone.length === 0) return;
  index.transaction(() => {
    for (const hash of gone) deleteRow(index, hash);
    for (const doc of stale) {
      deleteRow(index, doc.hash);
      insertRow(index, root, doc);
    }
  })();
}

function insertRow(index: Database, root: string, doc: DocumentRecord): void {
  const row = indexRowOf(root, doc);
  index
    .query(
      `INSERT INTO search_index (hash, card, reading, transcription)
     VALUES ($hash, $card, $reading, $transcription)`,
    )
    .run({
      $hash: doc.hash,
      $card: row.card,
      $reading: row.reading,
      $transcription: row.transcription,
    });
  index
    .query(
      `INSERT OR REPLACE INTO indexed (hash, fingerprint)
     VALUES ($hash, $fingerprint)`,
    )
    .run({ $hash: doc.hash, $fingerprint: fingerprintOf(root, doc) });
}

function deleteRow(index: Database, hash: string): void {
  index
    .query("DELETE FROM search_index WHERE hash = $hash")
    .run({ $hash: hash });
  index.query("DELETE FROM indexed WHERE hash = $hash").run({ $hash: hash });
}

/** Bring one Document's entry in the index up to date with what is known about it. */
export function indexDocument(lib: Library, hash: string): void {
  unindexDocument(lib, hash);
  const doc = lib.documents.get(hash);
  if (doc) insertRow(lib.index, lib.root, doc);
}

/** Drop one Document from the index. */
export function unindexDocument(lib: Library, hash: string): void {
  deleteRow(lib.index, hash);
}
/**
 * How much of the Transcription a snippet shows either side of the match: a
 * line or two on a card, with the match near its start.
 */
const BEFORE = 30;
const AFTER = 70;

/**
 * The passage of a Transcription around the first place `anchor` is found,
 * with every term inside it marked. Matching runs on folded text and the marks
 * are traced back to the Transcription's own spelling, so "verfugung" marks
 * "Verfügung". Line breaks are flattened, since a snippet is one run of text.
 */
function snippetOf(
  transcription: string,
  terms: string[],
  anchor: string,
): Snippet | null {
  const text = transcription.replace(/\s+/g, " ").trim();
  // For each code unit of the folded text, the span of the original it came from.
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const c of text) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(i + c.length);
    }
    folded += f;
    i += c.length;
  }

  const at = folded.indexOf(anchor);
  if (at === -1) return null;
  const matchStart = from[at] ?? 0;
  const matchEnd = to[at + anchor.length - 1] ?? 0;
  let start = Math.max(0, matchStart - BEFORE);
  let end = Math.min(text.length, matchEnd + AFTER);
  // Cut at word boundaries, so a snippet never opens or closes mid-word —
  // except inside the word holding the match, as a long compound can be, which
  // is cut through rather than dropped from its own snippet.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < matchStart) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space >= matchEnd) end = space;
  }

  const lead = start > 0 ? "…" : "";
  const marks: [number, number][] = [];
  for (const term of terms) {
    for (
      let f = folded.indexOf(term);
      f !== -1;
      f = folded.indexOf(term, f + 1)
    ) {
      const a = from[f] ?? 0;
      const b = to[f + term.length - 1] ?? 0;
      if (a >= start && b <= end)
        marks.push([a - start + lead.length, b - start + lead.length]);
    }
  }
  marks.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  // Overlapping terms ("nord", "nordhaus") mark one passage, not two.
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged.at(-1);
    if (last && m[0] < last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push(m);
  }
  return {
    text: lead + text.slice(start, end) + (end < text.length ? "…" : ""),
    marks: merged,
  };
}

/** The tier a folded term is found in, or null when the Document doesn't hold it. */
function tierOf(row: IndexRow, term: string): SearchTier | null {
  if (row.card.includes(term)) return 1;
  if (row.reading.includes(term)) return 2;
  if (row.transcription.includes(term)) return 3;
  return null;
}

/**
 * A term as an FTS5 query: quoted, so punctuation in it is text rather than
 * query syntax.
 */
const phrase = (term: string) => `"${term.replaceAll('"', '""')}"`;

type Candidate = IndexRow & {
  hash: string;
  doc_date: string | null;
  added_at: string;
};

/**
 * "Newest first" by the Document's own date, as the gallery's Newest sorts:
 * undated Documents last, and the latest filed first among equals.
 */
function newestFirst(a: Candidate, b: Candidate): number {
  if (a.doc_date !== b.doc_date) {
    if (!a.doc_date) return 1;
    if (!b.doc_date) return -1;
    return b.doc_date.localeCompare(a.doc_date);
  }
  return b.added_at.localeCompare(a.added_at);
}

/**
 * The Documents a query finds, in Best match order: by the tier of each one's
 * weakest term, then newest first. A Document's tier is its weakest term's
 * because every term had to be found for it to match at all — one found only in
 * the Transcription is a match only the Transcription vouches for.
 *
 * The index narrows the Library to the Documents holding every term it can
 * look up; which column each term was found in, and whether the shorter terms
 * are there at all, is then read off the folded text itself. A trigram index
 * cannot look up a term shorter than three characters ("AG", "Nr"), so a query
 * made only of those reads every Document — cheap at the size of one person's
 * Library.
 */
export function searchLibrary(lib: Library, query: string): ApiSearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const indexed = terms.filter((t) => Array.from(t).length >= 3);
  const select = "SELECT hash, card, reading, transcription FROM search_index";
  const rows = (
    indexed.length > 0
      ? lib.index
          .query(`${select} WHERE search_index MATCH $q`)
          .all({ $q: indexed.map(phrase).join(" AND ") })
      : lib.index.query(select).all()
  ) as (IndexRow & { hash: string })[];
  // An entry whose Document has left the Library is one a Delete did not get
  // to; it finds nothing.
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const doc = lib.documents.get(row.hash);
    if (doc)
      candidates.push({ ...row, doc_date: doc.docDate, added_at: doc.addedAt });
  }

  const hits: { hash: string; tiers: SearchTier[]; row: Candidate }[] = [];
  for (const row of candidates) {
    const tiers = terms.map((term) => tierOf(row, term));
    if (!tiers.includes(null))
      hits.push({ hash: row.hash, tiers: tiers as SearchTier[], row });
  }
  const tierOfHit = (h: (typeof hits)[number]) =>
    Math.max(...h.tiers) as SearchTier;
  return hits
    .sort((a, b) => tierOfHit(a) - tierOfHit(b) || newestFirst(a.row, b.row))
    .map((h) => {
      const tier = tierOfHit(h);
      // Anchored on the first term only the Transcription holds: the one the
      // card can't account for.
      const anchor = terms[h.tiers.indexOf(3)];
      return {
        hash: h.hash,
        tier,
        snippet:
          tier === 3 && anchor
            ? snippetOf(readTranscriptionSync(lib.root, h.hash), terms, anchor)
            : null,
      };
    });
}
