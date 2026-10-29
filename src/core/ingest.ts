import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  type CatalogFields,
  deleteDocument,
  getDocument,
  insertDocument,
  type Library,
} from "./db.ts";
import { aboutDir, derivedDir, ensureDirs, objectPath } from "./library.ts";
import {
  hasObject,
  putObject,
  removeObject,
  sha256File,
  sniffMime,
} from "./store.ts";
import { removeTranscription } from "./transcription.ts";

export type ImportResult = {
  hash: string;
  status: "imported";
  deduped: boolean;
  path: string;
};

/**
 * Ingest a file into the library: hash it, store the original content-addressed,
 * and file it with its `document.yaml`. Idempotent — importing the same content twice is a no-op.
 */
export async function importFile(
  lib: Library,
  srcPath: string,
): Promise<ImportResult> {
  const info = await stat(srcPath).catch(() => null);
  if (!info) throw new Error(`file not found: ${srcPath}`);
  if (!info.isFile()) throw new Error(`not a file: ${srcPath}`);

  const ext = extname(srcPath).replace(/^\./, "").toLowerCase();
  const bytes = info.size;
  const hash = await sha256File(srcPath);
  const mime = await sniffMime(srcPath);

  ensureDirs(lib.root);

  const existing = getDocument(lib, hash);
  if (existing) {
    // The catalog says we have it, but the object can vanish out of band
    // (manual delete, lost disk). Re-store from the source so dedup never
    // hands back a path to a missing file.
    if (!(await hasObject(lib.root, hash, existing.ext))) {
      await putObject(lib.root, srcPath, hash, existing.ext);
    }
    return {
      hash,
      status: "imported",
      deduped: true,
      path: objectPath(lib.root, hash, existing.ext),
    };
  }

  // The Original first and `document.yaml` last: the file is what puts the
  // Document in the Library, so a crash before it leaves an Original that is
  // ignored, and Importing the same file again completes the Import. A
  // Transcription left behind by an interrupted Delete belongs to no reading
  // this Document has, so it goes before the Document is filed.
  await putObject(lib.root, srcPath, hash, ext);
  // Looked at again after the await: a concurrent Import of the same file may
  // have filed it meanwhile, and its Transcription is no leftover.
  const filed = getDocument(lib, hash);
  if (filed)
    return {
      hash,
      status: "imported",
      deduped: true,
      path: objectPath(lib.root, hash, filed.ext),
    };
  removeTranscription(lib.root, hash);

  const rec: CatalogFields = {
    hash,
    ext,
    mime,
    filename: basename(srcPath),
    bytes,
    status: "imported",
    addedAt: new Date().toISOString(),
  };
  insertDocument(lib, rec);

  return {
    hash,
    status: "imported",
    deduped: false,
    path: objectPath(lib.root, hash, ext),
  };
}

/** No Document has this hash, so there is nothing to Delete. */
export class NoDocument extends Error {
  constructor(hash: string) {
    super(`no document with hash: ${hash}`);
  }
}

export type DeleteResult = {
  hash: string;
  status: "deleted";
  filename: string;
};

/**
 * Remove a document from the library: its `document.yaml` first, which is what
 * takes it out of the Library, then the content-addressed original, any derived
 * artifacts (thumbnails, …) and everything else known about it (its
 * transcription). A Delete interrupted after the first step leaves files that
 * are ignored. Idempotent at the file level — a missing object or directory is
 * not an error — but a Document not in the Library is, so a typo'd hash
 * surfaces instead of silently no-op'ing.
 */
export async function deleteFile(
  lib: Library,
  hash: string,
): Promise<DeleteResult> {
  const existing = getDocument(lib, hash);
  if (!existing) throw new NoDocument(hash);

  // Every removal in one go, with nothing awaited between them: an Import of
  // the same file made meanwhile cannot land between two of them and then
  // lose its Original or its `document.yaml` to the rest.
  deleteDocument(lib, hash);
  removeObject(lib.root, hash, existing.ext);
  rmSync(derivedDir(lib.root, hash), { recursive: true, force: true });
  rmSync(aboutDir(lib.root, hash), { recursive: true, force: true });

  return { hash, status: "deleted", filename: existing.filename };
}
