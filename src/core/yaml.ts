/**
 * The Library's readable files. Everything Zayla knows beyond the
 * Originals and Transcriptions is meant to be kept as YAML a person can open,
 * grep and diff: prose unquoted, multi-line text as an indented block, and no
 * line ever wrapped, so changing one word shows up as one changed line.
 *
 * There is no version ladder for these files. Fields are only ever added, and
 * a reader supplies a default for any field a file written before it lacks.
 */
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { writeAtomic, writeAtomicSync } from "./store.ts";

const toYaml = (value: object): string => stringify(value, { lineWidth: 0 });

/**
 * A file that is there but holds no record: not YAML, empty, or something other
 * than a map of fields. An empty file is what a crash can leave behind, so it is
 * refused rather than read as a record of nothing but defaults.
 */
export class UnreadableFile extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

/** What the file at `path` holds, any top-level field it lacks taken from `defaults`. */
function withDefaults<T extends object>(
  path: string,
  text: string,
  defaults: T,
): T {
  let read: unknown;
  try {
    read = parse(text);
  } catch (err) {
    throw new UnreadableFile(path, `not YAML (${(err as Error).message})`);
  }
  if (read === null || read === undefined)
    throw new UnreadableFile(path, "empty");
  if (typeof read !== "object" || Array.isArray(read))
    throw new UnreadableFile(path, "not a map of fields");
  return { ...defaults, ...(read as Partial<T>) };
}

/** Write `value` to `path` as YAML, whole or not at all. The caller owns the directory. */
export async function writeYamlFile(
  path: string,
  value: object,
): Promise<void> {
  await writeAtomic(path, toYaml(value));
}

/** `writeYamlFile`, synchronously. */
export function writeYamlFileSync(path: string, value: object): void {
  writeAtomicSync(path, toYaml(value));
}

/**
 * Read the YAML file at `path`, any top-level field it lacks taking its value
 * from `defaults`; null when there is no file, and UnreadableFile when there is
 * one that holds no record. Defaults are not merged into nested objects. A
 * field present but null stays null: only what a file never wrote is defaulted.
 */
export async function readYamlFile<T extends object>(
  path: string,
  defaults: T,
): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return withDefaults(path, await file.text(), defaults);
}

/** `readYamlFile`, synchronously. */
export function readYamlFileSync<T extends object>(
  path: string,
  defaults: T,
): T | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return withDefaults(path, text, defaults);
}
