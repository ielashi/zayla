/**
 * One writer at a time. A process that changes the Library holds a lock file
 * under its root recording its process id and what it is; the server holds it
 * for as long as it runs. Nothing watches the files for changes made by
 * someone else, so a second writer is refused rather than left to overwrite
 * the first one's work.
 *
 * Synchronous node:fs rather than Bun.file throughout: the lock is taken by
 * openLibrary, which is synchronous, and Bun has no counterpart to link().
 */
import { Database } from "bun:sqlite";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { lockPath } from "./library.ts";

/** What the server names itself as when it holds the lock. */
export const SERVER = "server";

/** What holds the lock: its process id, and what it is (SERVER, or a command). */
export type LockHolder = { pid: number; by: string };

/** The lock as held by this process; let go of it when done writing. */
export type WriterLock = { release(): void };

/** Another writer holds the Library's lock. */
export class LibraryLocked extends Error {
  constructor(readonly holder: LockHolder) {
    super(`the library is held by ${holder.by} (process ${holder.pid})`);
  }
}

/**
 * The locks this process holds, by path. A lock file naming this process's
 * id is this process's only if it is here: otherwise an earlier process with
 * the same id left it — a container's server is process 1 every time it
 * starts — and it is as stale as any other.
 */
const held = new Set<string>();

/** Take the Library's writer lock at `root` as `by`, or throw LibraryLocked. */
export function takeWriterLock(root: string, by: string): WriterLock {
  const path = lockPath(root);
  const mine: LockHolder = { pid: process.pid, by };
  // Written whole beside the lock, then linked into place: a link is made only
  // where there is no file yet, so of two processes taking the lock at once
  // exactly one gets it, and nobody ever reads a lock file half-written.
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, stringify(mine));
  try {
    for (;;) {
      try {
        linkSync(tmp, path);
        return heldAt(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      removeIfStale(path);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Remove the lock at `path` if the process that left it is gone, so the
 * caller can try again; throw LibraryLocked if a live process holds it.
 *
 * Done under a guard: an exclusive lock on `<path>.guard` that the operating
 * system holds for this process and lets go of by itself should the process
 * die, so a crash here never leaves the guard held. Of two processes finding
 * the same stale lock, the second looks only once the first is done, and then
 * finds the first's live lock rather than the stale one. So the lock read is
 * always the lock removed, and a live lock is never removed: only the process
 * holding a lock ever removes it, on release.
 */
function removeIfStale(path: string): void {
  const guard = new Database(`${path}.guard`);
  try {
    guard.exec("PRAGMA busy_timeout = 10000");
    guard.exec("BEGIN EXCLUSIVE");
    const holder = holderOf(path);
    if (!holder) return;
    if (held.has(path) || isAnotherLiveProcess(holder.pid))
      throw new LibraryLocked(holder);
    // Its process is gone, so nothing is writing: take it over.
    rmSync(path, { force: true });
  } finally {
    guard.close();
  }
}

/**
 * The lock at `path`, now held by this process. It is let go of on release,
 * and on the way out of a process that exits without releasing it — a CLI
 * command that fails exits on the spot — so that only a crash ever leaves a
 * lock behind, and a crash's lock is taken over.
 */
function heldAt(path: string): WriterLock {
  held.add(path);
  const release = () => {
    process.off("exit", release);
    held.delete(path);
    rmSync(path, { force: true });
  };
  process.on("exit", release);
  return { release };
}

/** What the lock file at `path` says holds it; null once it has gone. */
function holderOf(path: string): LockHolder | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const read = parse(text) as Partial<LockHolder> | null;
  return { pid: Number(read?.pid), by: read?.by ?? "another process" };
}

/**
 * Whether `pid` is a process other than this one that is still running.
 * Signal 0 checks without signalling: it fails with ESRCH when there is no
 * such process, and with EPERM when there is one this process may not signal.
 */
function isAnotherLiveProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
