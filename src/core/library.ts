import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Root of the document library. Override with LIBRARY_DIR (Bun auto-loads .env). */
export function libraryRoot(): string {
  return process.env.LIBRARY_DIR ?? "./library";
}

/** Directory holding the content-addressed originals. */
export function objectsDir(root: string): string {
  return join(root, "objects");
}

/** On-disk path for an original, addressed by its content hash. */
export function objectPath(root: string, hash: string, ext: string): string {
  return join(objectsDir(root), ext ? `${hash}.${ext}` : hash);
}

/** Path to the readable file holding the Library's Persons, Organizations and Merges. */
export function namingPath(root: string): string {
  return join(root, "naming.yaml");
}

/** Directory holding one readable file per user of the Library at `root`. */
export function usersDir(root: string): string {
  return join(root, "users");
}

/** Path to the readable file holding everything about one user. */
export function userFilePath(root: string, id: string): string {
  return join(usersDir(root), `${id}.yaml`);
}

/** Path to the readable file holding what the Library at `root` knows about one Document. */
export function documentFilePath(root: string, hash: string): string {
  return join(root, "about", hash, "document.yaml");
}

/** Path to the search index of the Library at `root`: a Derived artifact, rebuilt at will. */
export function searchIndexPath(root: string): string {
  return join(root, "derived", "search.db");
}

/** Path to the lock file the Library's one writer holds while it runs. */
export function lockPath(root: string): string {
  return join(root, "lock.yaml");
}

/**
 * Materialize the library's on-disk layout. Idempotent, and the single owner of
 * directory creation — creating the objects directory also creates `root`, where
 * `naming.yaml` and the lock file live.
 */
export function ensureDirs(root: string): void {
  mkdirSync(join(root, "objects"), { recursive: true });
  mkdirSync(join(root, "derived"), { recursive: true });
  mkdirSync(join(root, "about"), { recursive: true });
}

/** Directory holding derived artifacts (thumbnails, …) for one document. */
export function derivedDir(root: string, hash: string): string {
  return join(root, "derived", hash);
}

/** On-disk path for a document's cached first-page thumbnail. */
export function thumbPath(root: string, hash: string): string {
  return join(derivedDir(root, hash), "thumb.jpg");
}

/** On-disk path for how many pages a document's Original has, as poppler counted them. */
export function pageCountPath(root: string, hash: string): string {
  return join(derivedDir(root, hash), "pages.txt");
}

/** On-disk path for one page of a document, rendered to a JPEG (1-based). */
export function pagePath(root: string, hash: string, n: number): string {
  return join(derivedDir(root, hash), `page-${n}.jpg`);
}

/** Create a document's derived directory. Mirrors ensureDirs — library.ts owns dir creation. */
export function ensureDerivedDir(root: string, hash: string): void {
  mkdirSync(derivedDir(root, hash), { recursive: true });
}

/**
 * Directory holding what the Library knows about one document beyond its Original:
 * its `document.yaml` and its Transcription. Unlike derivedDir(), nothing here is recomputable — a
 * Transcription costs a model call — so this directory is never safe to wipe to
 * reclaim space.
 */
export function aboutDir(root: string, hash: string): string {
  return join(root, "about", hash);
}

/** On-disk path for a document's Transcription — the model's word-for-word reading. */
export function transcriptionPath(root: string, hash: string): string {
  return join(aboutDir(root, hash), "transcription.txt");
}

/** Create a document's about directory. Mirrors ensureDerivedDir — library.ts owns dir creation. */
export function ensureAboutDir(root: string, hash: string): void {
  mkdirSync(aboutDir(root, hash), { recursive: true });
}
