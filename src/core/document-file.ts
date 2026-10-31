/**
 * A Document's `about/<hash>/document.yaml`: everything the Library knows about
 * it beyond its Original and its Transcription's text — the catalog fields, the
 * Enrichment with its titles and summaries in each Reading language, and where
 * both the Enrichment and the Transcription came from.
 *
 * The file is the commit point: a Document is in the Library exactly when its
 * `document.yaml` exists. Its folder is named by the Document's hash, so the
 * file itself doesn't repeat it.
 *
 * Fields are written for a person to read, in the order they would look for
 * them. A field a file lacks reads as its default, so an older file stays
 * readable as fields are added. Nothing but this module knows the file's shape.
 */

import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DocumentStatus } from "../shared.ts";
import type { DocumentRecord } from "./db.ts";
import type { Deadline, Party, WrittenText } from "./enrich.ts";
import { documentFilePath } from "./library.ts";
import type { TranscriptionRecord } from "./transcription.ts";
import { readYamlFileSync, UnreadableFile, writeYamlFileSync } from "./yaml.ts";

/** Where an Enrichment came from, as the file keeps it. */
type EnrichmentFile = {
  text_source?: string | null;
  base_url?: string | null;
  model?: string | null;
  enriched_at?: string | null;
  /** The backend an Enrichment made before addresses were recorded named instead. */
  provider?: string | null;
};

/** Where a Transcription came from, as the file keeps it. */
type TranscriptionFile = {
  model: string;
  base_url: string;
  truncated: boolean | null;
  finish_reason: string | null;
  chars: number;
  created_at: string;
};

type DocumentFile = {
  filename: string;
  ext: string;
  mime: string;
  bytes: number;
  status: DocumentStatus;
  added_at: string;
  texts: Record<string, WrittenText>;
  date: string | null;
  languages: string[] | null;
  sender: Party | null;
  receiver: Party | null;
  people: string[] | null;
  deadlines: Deadline[] | null;
  keywords: string[] | null;
  enrichment: EnrichmentFile | null;
  transcription: TranscriptionFile | null;
};

/** What a file that never wrote a field reads as. */
const DEFAULTS: DocumentFile = {
  filename: "",
  ext: "",
  mime: "application/octet-stream",
  bytes: 0,
  status: "imported",
  added_at: "",
  texts: {},
  date: null,
  languages: null,
  sender: null,
  receiver: null,
  people: null,
  deadlines: null,
  keywords: null,
  enrichment: null,
  transcription: null,
};

/**
 * The file for a record. An unread Document's file holds its catalog fields
 * alone; the Enrichment's fields appear once it has been read.
 */
function toFile(rec: DocumentRecord): Partial<DocumentFile> {
  const t = rec.transcriptionProvenance;
  const enrichment = recorded<EnrichmentFile>({
    text_source: rec.textSource,
    base_url: rec.enrichBaseUrl,
    model: rec.enrichModel,
    enriched_at: rec.enrichedAt,
    provider: rec.enrichProvider,
  });
  return recorded<DocumentFile>({
    filename: rec.filename,
    ext: rec.ext,
    mime: rec.mime,
    bytes: rec.bytes,
    status: rec.status,
    added_at: rec.addedAt,
    texts: rec.texts,
    date: rec.docDate,
    languages: rec.languages,
    sender: rec.sender,
    receiver: rec.receiver,
    people: rec.people,
    deadlines: rec.deadlines,
    keywords: rec.keywords,
    enrichment,
    transcription: t && {
      model: t.model,
      base_url: t.baseUrl,
      truncated: t.truncated,
      finish_reason: t.finishReason,
      chars: t.chars,
      created_at: t.createdAt,
    },
  });
}

/** `value` without its top-level fields that hold nothing: null, or an empty map. */
function recorded<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v !== null &&
        !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length),
    ),
  ) as Partial<T>;
}

function fromFile(hash: string, file: DocumentFile): DocumentRecord {
  const e = file.enrichment ?? {};
  const t = file.transcription;
  const transcriptionProvenance: TranscriptionRecord | null = t
    ? {
        truncated: t.truncated ?? null,
        finishReason: t.finish_reason ?? null,
        baseUrl: t.base_url,
        model: t.model,
        chars: t.chars,
        createdAt: t.created_at,
      }
    : null;
  return {
    hash,
    ext: file.ext,
    mime: file.mime,
    filename: file.filename,
    bytes: file.bytes,
    status: file.status,
    addedAt: file.added_at,
    texts: file.texts ?? {},
    people: file.people,
    docDate: file.date,
    languages: file.languages,
    keywords: file.keywords,
    textSource: e.text_source ?? null,
    enrichProvider: e.provider ?? null,
    enrichBaseUrl: e.base_url ?? null,
    enrichModel: e.model ?? null,
    enrichedAt: e.enriched_at ?? null,
    sender: file.sender,
    receiver: file.receiver,
    deadlines: file.deadlines,
    transcriptionProvenance,
  };
}

/** Write a Document's file, whole or not at all: this is what files it. */
export function writeDocumentFile(root: string, rec: DocumentRecord): void {
  const path = documentFilePath(root, rec.hash);
  mkdirSync(dirname(path), { recursive: true });
  writeYamlFileSync(path, toFile(rec));
}

/** Whether a Document is filed: whether its file exists. */
export function documentFileExists(root: string, hash: string): boolean {
  return existsSync(documentFilePath(root, hash));
}

/** Remove a Document's file: the first step of Deleting it. */
export function removeDocumentFile(root: string, hash: string): void {
  rmSync(documentFilePath(root, hash), { force: true });
}

/**
 * Every Document filed in the Library at `root`, read from its file. A folder
 * under `about/` without a `document.yaml` is what an interrupted Import or
 * Delete leaves behind, and is not a Document.
 */
export function readDocumentFiles(root: string): DocumentRecord[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, "about"), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: DocumentRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = documentFilePath(root, entry.name);
    try {
      const file = readYamlFileSync(path, DEFAULTS);
      if (file) records.push(fromFile(entry.name, checked(path, file)));
    } catch (err) {
      // One Document's file the Library can't make sense of costs that
      // Document, not the whole Library: it is left out, and said so.
      if (!(err instanceof UnreadableFile)) throw err;
      console.warn(`left out of the Library: ${err.message}`);
    }
  }
  return records;
}

/** `file`, once the fields every Document has are known to be what they should. */
function checked(path: string, file: DocumentFile): DocumentFile {
  for (const field of [
    "filename",
    "ext",
    "mime",
    "status",
    "added_at",
  ] as const)
    if (typeof file[field] !== "string")
      throw new UnreadableFile(path, `${field} is not text`);
  if (typeof file.bytes !== "number")
    throw new UnreadableFile(path, "bytes is not a number");
  if (file.texts !== null && typeof file.texts !== "object")
    throw new UnreadableFile(path, "texts is not a map");
  return file;
}
