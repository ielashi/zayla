import type { DocumentStatus } from "../shared.ts";
import {
  documentFileExists,
  readDocumentFiles,
  removeDocumentFile,
  writeDocumentFile,
} from "./document-file.ts";
import type {
  Deadline,
  EnrichedMetadata,
  Party,
  WrittenText,
} from "./enrich.ts";
import {
  type Appearance,
  deriveAllAppearances,
  dropAppearances,
  type Naming,
  readNaming,
  recordAppearances,
} from "./entities.ts";
import { ensureDirs } from "./library.ts";
import { takeWriterLock, type WriterLock } from "./lock.ts";
import {
  indexDocument,
  openSearchIndex,
  type SearchIndex,
  unindexDocument,
} from "./search.ts";
import type { TranscriptionRecord } from "./transcription.ts";
import { readUserFiles, type UserState } from "./user-file.ts";

export type { DocumentStatus };

/**
 * A filed Document, as its `document.yaml` holds it (see document-file.ts).
 * The catalog fields are written when it is filed; the enrichment fields
 * (texts, keywords, …) are populated by the `enrich` pass and are null until
 * then.
 */
export type DocumentRecord = {
  hash: string;
  ext: string;
  mime: string;
  filename: string;
  bytes: number;
  status: DocumentStatus;
  addedAt: string; // ISO-8601

  // Enrichment — null until enriched.
  /**
   * The title and summary in each language they were written in, keyed by
   * uppercase code, in the order they were written; empty until enriched.
   * Languages a user has since stopped reading in are kept.
   */
  texts: Record<string, WrittenText>;
  people: string[] | null;
  docDate: string | null;
  languages: string[] | null;
  keywords: string[] | null;
  ref: { key: string; value: string }[] | null;
  textSource: string | null;
  /**
   * The backend named by an Enrichment made before addresses were recorded.
   * Never written since, so a Document read again keeps it beside its enrichBaseUrl.
   */
  enrichProvider: string | null;
  /** Where the Document was sent for reading; null on Enrichments made before addresses were recorded. */
  enrichBaseUrl: string | null;
  enrichModel: string | null;
  enrichedAt: string | null;

  sender: Party | null;
  receiver: Party | null;
  deadlines: Deadline[] | null;

  /** Where the Document's Transcription came from; null when it has none. */
  transcriptionProvenance: TranscriptionRecord | null;
};

/** A login challenge in flight, held in memory for the few minutes it lives. */
export type PendingChallenge = { challenge: string; createdAt: number };

/**
 * An open Library: what every core module, the server and the CLI are handed.
 *
 * Everything durable lives in readable files under `root` (ADR 0003), read
 * when the Library is opened and held in memory: every Document from its
 * `document.yaml`, the naming from `naming.yaml`, and every user from
 * `users/<id>.yaml`. Every change is written to its file first and to memory
 * after. The Appearances are held only in memory, worked out from each
 * Document's Enrichment. Search has its own index, a Derived artifact and the
 * one SQLite database left.
 */
export type Library = {
  readonly root: string;
  /** The lock this handle holds as the Library's one writer, if it took it. */
  readonly lock: WriterLock | null;
  /** Every Document in the Library, by hash. */
  readonly documents: Map<string, DocumentRecord>;
  /** Every Person and Organization, their Name variants, and the Merges. */
  readonly naming: Naming;
  /** Each Document's Appearances, by hash; a Document naming no one has none. */
  readonly appearances: Map<string, Appearance[]>;
  /** Every user, by id. */
  readonly users: Map<string, UserState>;
  /** Login challenges in flight, by the id their cookie carries. Never written. */
  readonly challenges: Map<string, PendingChallenge>;
  /** The search index (see search.ts). */
  readonly index: SearchIndex;
};

export type OpenOptions = {
  /**
   * Take the Library's writer lock, naming what holds it (`"server"`, or the
   * CLI command), and refuse with LibraryLocked while another live process
   * has it. Without it the handle only reads.
   */
  writer?: string;
};

/**
 * Open (creating if needed) the Library at `root`: read every Document's,
 * the naming's and every user's file, work out the Appearances from each
 * Document's Enrichment, and open the search index, bringing it in step with
 * the Documents (see search.ts). Only a writer touches the index's file.
 */
export function openLibrary(root: string, options: OpenOptions = {}): Library {
  ensureDirs(root);
  const lock = options.writer ? takeWriterLock(root, options.writer) : null;
  let index: SearchIndex | null = null;
  try {
    const documents = new Map(
      readDocumentFiles(root).map((doc) => [doc.hash, doc]),
    );
    const naming = readNaming(root);
    const users = readUserFiles(root);
    index = openSearchIndex(root, documents, lock !== null);
    const lib: Library = {
      root,
      lock,
      documents,
      naming,
      appearances: new Map(),
      users,
      challenges: new Map(),
      index,
    };
    deriveAllAppearances(lib);
    return lib;
  } catch (err) {
    index?.close();
    lock?.release();
    throw err;
  }
}

/** Close the Library and let go of the writer lock. */
export function closeLibrary(lib: Library): void {
  try {
    lib.index.close();
  } finally {
    lib.lock?.release();
  }
}

/** The catalog fields written at import time (before enrichment). */
export type CatalogFields = Pick<
  DocumentRecord,
  "hash" | "ext" | "mime" | "filename" | "bytes" | "status" | "addedAt"
>;

/**
 * File a Document: write its `document.yaml`, which is what puts it in the
 * Library. Returns true if it was filed now, false if it already was.
 */
export function insertDocument(lib: Library, rec: CatalogFields): boolean {
  if (lib.documents.has(rec.hash)) return false;
  const record: DocumentRecord = {
    ...rec,
    texts: {},
    people: null,
    docDate: null,
    languages: null,
    keywords: null,
    ref: null,
    textSource: null,
    enrichProvider: null,
    enrichBaseUrl: null,
    enrichModel: null,
    enrichedAt: null,
    sender: null,
    receiver: null,
    deadlines: null,
    transcriptionProvenance: null,
  };
  writeDocumentFile(lib.root, record);
  lib.documents.set(rec.hash, record);
  // Unread, a Document can still be found by its filename.
  indexDocument(lib, rec.hash);
  return true;
}

export function getDocument(lib: Library, hash: string): DocumentRecord | null {
  return lib.documents.get(hash) ?? null;
}

/**
 * Take a Document out of the Library: its `document.yaml` goes first, which is
 * what takes it out, then the Appearances recorded against it and its entry in
 * the search index. Its Original and the rest of its folders are the caller's
 * to remove (see `deleteFile`); left behind, they are ignored. No-op if the
 * hash isn't filed.
 *
 * What does not go is the naming — a Person or Organization keeps its name
 * variants once its last Document is gone, so deciding that two spellings are
 * one name survives.
 */
export function deleteDocument(lib: Library, hash: string): void {
  removeDocumentFile(lib.root, hash);
  lib.documents.delete(hash);
  dropAppearances(lib, hash);
  unindexDocument(lib, hash);
}

/** Latest filed first. */
const newestFiled = (a: DocumentRecord, b: DocumentRecord) =>
  b.addedAt.localeCompare(a.addedAt);

export function listDocuments(lib: Library): DocumentRecord[] {
  return [...lib.documents.values()].sort(newestFiled);
}

/**
 * Resolve a full hash or a leading prefix (e.g. the 12-char id `list` prints) to
 * its documents. 0 matches = not found; >1 = ambiguous prefix.
 */
export function findDocumentsByPrefix(
  lib: Library,
  ref: string,
): DocumentRecord[] {
  return [...lib.documents.values()]
    .filter((d) => d.hash.startsWith(ref))
    .sort((a, b) => a.hash.localeCompare(b.hash));
}

/**
 * Documents that haven't been through the enrichment pass yet — including
 * legacy ones flagged `needs_ocr` before the pipeline went vision-only.
 */
export function listPending(lib: Library): DocumentRecord[] {
  return listDocuments(lib).filter(
    (d) => d.status === "imported" || d.status === "needs_ocr",
  );
}

/** Where a reading came from: how the text was read, the address, and the model. */
export type Provenance = { textSource: string; baseUrl: string; model: string };

/**
 * Write a reading into its Document's `document.yaml` and flip its status to
 * 'enriched', with where the reading and its Transcription came from (null when
 * it read back none). Re-runnable (overwrites): a reading's titles and
 * summaries replace the whole set the Document had, in every language, as the
 * rest of the reading replaces what came before it. The Document's
 * Transcription is written before this, so the search index picks the new one
 * up here, along with the rest of the reading. The reading's Appearances
 * replace the Document's previous ones, and a spelling it names for the first
 * time is learned, after the Document's own file is written.
 *
 * Writes nothing and returns false when the Document's `document.yaml` is gone:
 * a reading never brings back a Document that was Deleted.
 */
export function updateEnrichment(
  lib: Library,
  hash: string,
  meta: EnrichedMetadata,
  provenance: Provenance,
  transcription: TranscriptionRecord | null = null,
): boolean {
  const doc = lib.documents.get(hash);
  if (!doc || !documentFileExists(lib.root, hash)) return false;
  const record: DocumentRecord = {
    ...doc,
    status: "enriched",
    texts: { ...meta.texts },
    people: meta.people,
    docDate: meta.date,
    languages: meta.languages,
    keywords: meta.keywords,
    ref: meta.ref,
    sender: meta.sender,
    receiver: meta.receiver,
    deadlines: meta.deadlines,
    textSource: provenance.textSource,
    enrichBaseUrl: provenance.baseUrl,
    enrichModel: provenance.model,
    enrichedAt: new Date().toISOString(),
    transcriptionProvenance: transcription,
  };
  writeDocumentFile(lib.root, record);
  lib.documents.set(hash, record);
  indexDocument(lib, hash);
  recordAppearances(lib, record);
  return true;
}
