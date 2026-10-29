import { readFileSync, rmSync } from "node:fs";
import { ensureAboutDir, transcriptionPath } from "./library.ts";
import { writeAtomicSync } from "./store.ts";

/**
 * What only the enrichment call knows about a Transcription: which model read the
 * document and where, and whether it stopped because the document ended or
 * because it ran out of room. `truncated` is the fact that cannot be recovered
 * afterwards — a Transcription that stops at page 12 of 40 reads exactly like a
 * complete one.
 *
 * It is kept in the Document's `document.yaml`, beside the Enrichment it came
 * with (see db.ts).
 */
export type TranscriptionProvenance = {
  /** Whether the reading ran out of room; null when the backend reported no stop reason. */
  truncated: boolean | null;
  /** The backend's stop reason ("stop", "length", …); null when it reports none. */
  finishReason: string | null;
  /** Where the document was sent for reading. */
  baseUrl: string;
  model: string;
};

/** A Transcription's provenance as recorded: with its length and when it was made. */
export type TranscriptionRecord = TranscriptionProvenance & {
  chars: number;
  createdAt: string;
};

/**
 * Store a Transcription. It goes to a temp file and is renamed into place —
 * mirroring putObject — so a crash mid-write never replaces a good
 * Transcription with a partial one. Re-transcribing overwrites it.
 *
 * Synchronous, so that an Enrichment's check that its Document still exists,
 * this write and the Document's own write cannot be split by a Delete.
 */
export function writeTranscription(
  root: string,
  hash: string,
  text: string,
): void {
  ensureAboutDir(root, hash);
  writeAtomicSync(transcriptionPath(root, hash), text);
}

/**
 * Drop a document's Transcription, so a re-reading that came back empty cannot
 * leave an earlier model's text behind under the new model's name.
 */
export function removeTranscription(root: string, hash: string): void {
  rmSync(transcriptionPath(root, hash), { force: true });
}

/**
 * A document's Transcription, or null when it has none — never transcribed, or the
 * model read nothing back. Absence is normal, not an error.
 */
export async function readTranscription(
  root: string,
  hash: string,
): Promise<string | null> {
  const file = Bun.file(transcriptionPath(root, hash));
  return (await file.exists()) ? file.text() : null;
}

/**
 * `readTranscription`, synchronously, with "" for none. This is the one place
 * `node:fs` is preferred over `Bun.file`: the search index is kept in step
 * inside the synchronous writes that change a Document, and built inside one
 * transaction, neither of which can await a read.
 */
export function readTranscriptionSync(root: string, hash: string): string {
  try {
    return readFileSync(transcriptionPath(root, hash), "utf8");
  } catch {
    return "";
  }
}
