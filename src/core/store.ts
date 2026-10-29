import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { objectPath } from "./library.ts";

/** SHA-256 of a file's contents, as lowercase hex. This is a document's identity. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

/** Whether an original with this hash is already stored. */
export function hasObject(
  root: string,
  hash: string,
  ext: string,
): Promise<boolean> {
  return Bun.file(objectPath(root, hash, ext)).exists();
}

/**
 * A temp path beside `dest`, unique to one write: two writes to the same file in
 * flight at once, in one process or two, never share one.
 */
const tmpPathFor = (dest: string) =>
  `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`;

/**
 * Flush the directory at `dir` to disk, so a rename into it outlives a crash.
 * Best effort: not every platform lets a directory be opened and synced.
 */
function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported here; the rename itself is still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write to a temp file, flush it to disk and atomically rename it into place,
 * so a crash mid-write never leaves a partial or empty file at the destination.
 * The caller owns the directory.
 */
export async function writeAtomic(
  dest: string,
  data: string | Blob,
): Promise<void> {
  const tmp = tmpPathFor(dest);
  try {
    await Bun.write(tmp, data);
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, dest);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  fsyncDirSync(dirname(dest));
}

/**
 * `writeAtomic` for text, synchronously: for a write that must land in the same
 * tick as the in-memory state it mirrors, so nothing can come between checking
 * a Document is still there and writing beside it. The caller owns the directory.
 */
export function writeAtomicSync(dest: string, data: string): void {
  const tmp = tmpPathFor(dest);
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDirSync(dirname(dest));
}

/**
 * Copy an original into the content-addressed store. No-op if the object already
 * exists; never mutates or moves the source.
 */
export async function putObject(
  root: string,
  srcPath: string,
  hash: string,
  ext: string,
): Promise<void> {
  const dest = objectPath(root, hash, ext);
  if (await Bun.file(dest).exists()) return;
  await writeAtomic(dest, Bun.file(srcPath));
}

/**
 * Remove a content-addressed original. No-op if the object is already gone
 * (out-of-band delete, lost disk) — mirrors `putObject`'s idempotency in reverse.
 * Synchronous, so a Delete's removals land together (see `deleteFile`).
 */
export function removeObject(root: string, hash: string, ext: string): void {
  rmSync(objectPath(root, hash, ext), { force: true });
}

/**
 * Best-effort content type. Sniffs magic bytes for the formats this library
 * handles, falling back to the extension-derived type, then octet-stream — so a
 * misnamed or extensionless scan is still catalogued with the right mime.
 */
export async function sniffMime(path: string): Promise<string> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 12).arrayBuffer());
  return magicMime(head) ?? (Bun.file(path).type || "application/octet-stream");
}

function magicMime(b: Uint8Array): string | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return "application/pdf"; // %PDF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png"; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"; // GIF
  return null;
}
