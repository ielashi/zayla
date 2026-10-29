import { DEFAULT_READING_LANGUAGES } from "../languages.ts";
import { updateUser } from "./auth.ts";
import type { DocumentRecord, Library } from "./db.ts";
import type { WrittenText } from "./enrich.ts";

/**
 * Reading languages: which languages each user wants their Library in, and
 * which of a Document's titles they are shown.
 *
 * Every user has a list, from the moment they exist: [EN] until they choose.
 * It is kept in the user's own file. The list is validated before it reaches
 * here (`readingLanguagesFrom`).
 */

/** This user's Reading languages, in order of preference. */
export function readingLanguagesOf(lib: Library, userId: string): string[] {
  const languages = lib.users.get(userId)?.readingLanguages;
  return languages && languages.length > 0
    ? [...languages]
    : [...DEFAULT_READING_LANGUAGES];
}

/**
 * Replace this user's Reading languages. Nothing is read again, and nothing
 * already written in a language they drop is discarded: it is kept, found by
 * search, and shown again should they take that language back.
 */
export function setReadingLanguages(
  lib: Library,
  userId: string,
  languages: string[],
): void {
  const user = lib.users.get(userId);
  if (!user) throw new Error(`no user with id: ${userId}`);
  updateUser(lib, { ...user, readingLanguages: [...languages] });
}

/**
 * The title and summary a user is shown for a Document: in the Document's own
 * language, when that is one of theirs and was written; else in the first of
 * theirs that was; else in whatever language it has a title in. Null when it
 * has none, as before it is read.
 */
export function shownText(
  doc: Pick<DocumentRecord, "languages" | "texts">,
  readingLanguages: readonly string[],
): WrittenText | null {
  const titled = (code: string) =>
    doc.texts[code]?.title ? doc.texts[code] : undefined;
  const own = (doc.languages ?? []).find(
    (code) => readingLanguages.includes(code) && titled(code),
  );
  if (own) return titled(own) ?? null;
  for (const code of readingLanguages) {
    const text = titled(code);
    if (text) return text;
  }
  return Object.values(doc.texts).find((t) => t.title) ?? null;
}
