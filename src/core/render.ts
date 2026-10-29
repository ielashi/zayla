import { rename } from "node:fs/promises";
import { join } from "node:path";
import {
  derivedDir,
  ensureDerivedDir,
  objectPath,
  pageCountPath,
  pagePath,
  thumbPath,
} from "./library.ts";

/**
 * Render a document's first page to a cached JPEG thumbnail via poppler's `pdftoppm`.
 * Returns the thumbnail path. Throws (ShellError) if `pdftoppm` is unavailable or fails —
 * the server maps that to a 404 so the card falls back to a placeholder.
 */
export async function renderThumbnail(
  root: string,
  originalPath: string,
  hash: string,
): Promise<string> {
  ensureDerivedDir(root, hash);
  const prefix = join(derivedDir(root, hash), "thumb"); // pdftoppm -singlefile appends ".jpg"
  await Bun.$`pdftoppm -jpeg -singlefile -scale-to 480 ${originalPath} ${prefix}`.quiet();
  return thumbPath(root, hash);
}

/**
 * Render one page (1-based) of a PDF to a JPEG about 1600px wide, for the
 * viewer: a Derived artifact kept beside the thumbnail. Returns its path. It is rendered beside its final name and moved
 * into place, so a request arriving mid-render never reads half a page. Throws
 * (ShellError) if `pdftoppm` is unavailable or fails.
 */
export async function renderPage(
  root: string,
  originalPath: string,
  hash: string,
  n: number,
): Promise<string> {
  ensureDerivedDir(root, hash);
  const final = pagePath(root, hash, n);
  const prefix = `${final}.${crypto.randomUUID()}`; // -singlefile appends ".jpg"
  await Bun.$`pdftoppm -jpeg -singlefile -f ${n} -l ${n} -scale-to-x 1600 -scale-to-y -1 ${originalPath} ${prefix}`.quiet();
  await rename(`${prefix}.jpg`, final);
  return final;
}

/** What a page counter needs of a Document to count its pages. */
type Countable = { hash: string; ext: string; mime: string };

/** A page count read back, or null when it isn't one. */
const asCount = (text: string | undefined): number | null => {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** How many `pdfinfo` may run at once, so counting a whole Library doesn't spawn one per Document. */
const COUNTING_AT_ONCE = 8;

/**
 * Count the pages of the Library's Documents: an image has one, a PDF as many
 * as poppler's `pdfinfo` finds, and anything else, or a PDF poppler can't
 * read, has none known (null). A count is a Derived artifact, kept beside the
 * thumbnail so a restart doesn't count again, and held in memory once known —
 * an Original never changes, so neither does its count. A PDF that couldn't be
 * counted isn't tried again until the next start.
 */
export function pageCounter(
  root: string,
): (d: Countable) => Promise<number | null> {
  const known = new Map<string, number | null>();
  let running = 0;
  const waiting: (() => void)[] = [];

  async function pdfinfo(path: string): Promise<number | null> {
    while (running >= COUNTING_AT_ONCE)
      await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      const out = await Bun.$`pdfinfo ${path}`.quiet().text();
      return asCount(out.match(/^Pages:\s+(\d+)/m)?.[1]);
    } catch {
      return null; // poppler missing, or not a PDF it can read
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  return async ({ hash, ext, mime }) => {
    if (mime.startsWith("image/")) return 1;
    if (mime !== "application/pdf") return null;
    if (known.has(hash)) return known.get(hash) ?? null;

    const path = pageCountPath(root, hash);
    const file = Bun.file(path);
    let n = (await file.exists()) ? asCount((await file.text()).trim()) : null;
    if (n === null) {
      n = await pdfinfo(objectPath(root, hash, ext));
      if (n !== null) {
        // Written beside and moved into place, as a rendered page is.
        ensureDerivedDir(root, hash);
        const beside = `${path}.${crypto.randomUUID()}`;
        await Bun.write(beside, `${n}\n`);
        await rename(beside, path);
      }
    }
    known.set(hash, n);
    return n;
  };
}
