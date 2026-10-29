import { DEFAULT_READING_LANGUAGES, languageName } from "../languages.ts";
import type { Deadline, Party } from "../shared.ts";
import { updateUser } from "./auth.ts";
import type { Library } from "./db.ts";
import { type DocumentRecord, getDocument, updateEnrichment } from "./db.ts";
import { documentFileExists } from "./document-file.ts";
import { objectPath } from "./library.ts";
import { shownText } from "./reading-languages.ts";
import { removeTranscription, writeTranscription } from "./transcription.ts";

export type { Deadline, Party };

/**
 * Structured metadata derived from a document. Shape mirrors the fields
 * the UI prototype (index.html `DOCS`) renders. `related` (cross-document links)
 * is deliberately absent — it needs the whole library, not one document.
 */
export type EnrichedMetadata = {
  /**
   * The title and summary, written in each of the asking user's Reading
   * languages and keyed by its uppercase code. Every other field is the
   * Document's own.
   */
  texts: Record<string, WrittenText>;
  people: string[];
  /** Who issued the document — organization first, signing person optional. */
  sender: Party;
  /** Who the document is directed at. */
  receiver: Party;
  /** Action-required dates found in the document; empty when none. */
  deadlines: Deadline[];
  /** ISO yyyy-mm-dd, or null when the document has no clear date. */
  date: string | null;
  /** Language codes, uppercase (e.g. "DE", "EN", "AR"). */
  languages: string[];
  /**
   * Search terms the title and summary don't already contain: the document's
   * own original-language words and official abbreviations. Never displayed —
   * they exist only to be matched by the search box.
   */
  keywords: string[];
  /** Key facts to surface (application no., validity, etc.). */
  ref: { key: string; value: string }[];
};

/** A Document's title and summary in one language. */
export type WrittenText = { title: string; summary: string };

/** A document handed to a provider: the stored file itself, not extracted text. */
export type EnrichmentInput = {
  /** Path to the stored original (content-addressed object). */
  path: string;
  mime: string;
  filename: string;
  /** The uppercase codes to write the title and summary in, in order of preference. */
  readingLanguages: string[];
};

/** What a provider returns: the metadata plus the call's cost when the backend reports it. */
export type EnrichResult = {
  meta: EnrichedMetadata;
  /** The document read back word for word; null when the model produced none. */
  transcription: string | null;
  /** Why the model stopped — "length" means it hit its output ceiling; null when unreported. */
  finishReason: string | null;
  /** USD, as reported by the backend; null when it reports none. */
  costUsd: number | null;
};

/** A backend that turns a document (PDF or image) into structured metadata. */
export type EnrichmentProvider = {
  /** Where the document is sent for reading — recorded with every Enrichment. */
  readonly baseUrl: string;
  readonly model: string;
  enrich(doc: EnrichmentInput): Promise<EnrichResult>;
};

const SYSTEM = `You extract structured metadata from a personal document. You are looking at the document itself — a scan, a photo, or a digital PDF.
Write the title and summary in each of the languages listed below, whatever language the document is in; every other field stays as the document has it. If a field
is genuinely absent, use an empty array, an empty string, or null for the date.
Pay particular attention to identifying:
1. sender — who issued the document. The organization matters most: give the top-level institution, company, or authority (e.g. 'Stadt Porto'), NOT a department or sub-unit within it. Add the signing or contact person's name only if one is given, and name exactly ONE person: where several people signed, give the one who signed first, and never put two names in that field.
2. receiver — who the document is directed at (the addressee), same organization rule and the same one-person rule.
3. deadlines — every date by which an action is required (payment due, appeal period, appointment, expiry that demands action), each with a short label.
The title must be short and state the document's absolute key point, and MUST NOT exceed 60 characters in any language.
Keywords are search terms, not a summary. They are never shown to anyone — their only job is to let someone find this document by typing a word they remember. So:
- Do NOT repeat words that already appear in the title or summary; those are searched anyway and a keyword that echoes them is wasted.
- Keywords stay in the document's own language, whatever languages the title and summary are written in.
- DO include the document's own words in its original language ('Mietvertrag', 'Quellensteuer', 'Veranlagung'), official abbreviations and form codes ('BVG', 'KVG', 'F2'), and the general category someone would browse by ('insurance', 'tax', 'medical', 'rental').
Respond with the JSON the schema requires, then the transcription described below.`;

/**
 * The languages the title and summary are asked for: by name, which a model
 * follows more reliably than a bare code, with the code each is keyed by.
 */
const languagesSpec = (codes: string[]) =>
  `Write the title and summary in these languages: ${codes.map((c) => `${languageName(c)} ("${c}")`).join(", ")}.`;

/**
 * Prompt-level shape spec: the request carries no response_format, so the
 * prompt states the shape. The title and summary are objects keyed by the
 * code of each language they are written in.
 */
const jsonShape = (codes: string[]) => {
  const keyed = (what: string) =>
    `object { ${codes.map((c) => `"${c}": string`).join(", ")} } — ${what}, one entry per language, each written in that language`;
  return `Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
- title: ${keyed("short, the document's absolute key point, at most 60 characters")}
- people: array of strings
- sender: object { "organization": string, "person": string } — issuing party; organization is the top-level institution/company/authority (not a department within it), person optional and exactly one name (never two); empty strings when absent
- receiver: object { "organization": string, "person": string } — the addressee, same organization and one-person rules; empty strings when absent
- deadlines: array of objects, each { "label": string, "date": ISO "yyyy-mm-dd" string }
- date: ISO "yyyy-mm-dd" string, or null
- languages: array of uppercase language codes (e.g. "DE", "EN", "AR")
- keywords: array of search terms, per the keyword rule above
- summary: ${keyed("the summary")}
- ref: array of objects, each { "key": string, "value": string }`;
};

/** Marks where the metadata JSON ends and the transcription begins in a model response. */
export const TRANSCRIPTION_SENTINEL = "---TRANSCRIPTION---";

/**
 * Prompt spec for the verbatim transcription that follows the JSON. It comes after
 * the JSON rather than inside it so that hitting the output ceiling costs only the
 * tail of the text: the metadata is already complete and parseable by then.
 */
const TRANSCRIPTION_SPEC = `Then output ${TRANSCRIPTION_SENTINEL} on a line of its own, and after it transcribe the document word for word:
- Reproduce the text exactly as written, in its original language. Do not translate, summarize, correct or reorder anything.
- Keep paragraph breaks. Render tables as Markdown tables.
- Mark anything you cannot read as [illegible]. Never guess at it, and never skip it silently.
- Transcribe text only. Do not describe photos, logos, signatures or stamps.
Output nothing after the transcription.`;

/** Conservative per-request ceiling for base64 document/image inputs. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Load the stored file as base64, guarding the API size ceiling. */
async function loadBase64(doc: EnrichmentInput): Promise<string> {
  const file = Bun.file(doc.path);
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${doc.filename}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds the 32MB API limit`,
    );
  }
  return Buffer.from(await file.arrayBuffer()).toString("base64");
}

/**
 * The one enrichment backend: any server speaking the OpenAI-compatible chat
 * completions protocol, whether in the cloud or on this machine. It sends only
 * what that protocol defines — instructions as the system message, images as
 * data-URL `image_url` parts, PDFs as `file` parts — and nothing addressed to a
 * particular server. How a server reads a PDF (natively, as extracted text, or
 * through OCR) is that server's configuration, not ours.
 *
 * Output is normalized by the tolerant parseMetadata, since the JSON shape rides
 * in the prompt rather than in response_format. Cost is read when the server
 * reports one; otherwise it is null.
 */
class ChatCompletionsProvider implements EnrichmentProvider {
  constructor(
    readonly baseUrl: string,
    readonly model: string,
    private apiKey: string | undefined,
  ) {}

  async enrich(doc: EnrichmentInput): Promise<EnrichResult> {
    const data = await loadBase64(doc);
    const filePart =
      doc.mime === "application/pdf"
        ? {
            type: "file",
            file: {
              filename: doc.filename,
              file_data: `data:application/pdf;base64,${data}`,
            },
          }
        : doc.mime.startsWith("image/")
          ? {
              type: "image_url",
              image_url: { url: `data:${doc.mime};base64,${data}` },
            }
          : (() => {
              throw new Error(`unsupported document type: ${doc.mime}`);
            })();

    const res = await fetch(
      `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `${SYSTEM}\n${languagesSpec(doc.readingLanguages)}\n\n${jsonShape(doc.readingLanguages)}\n\n${TRANSCRIPTION_SPEC}`,
            },
            {
              role: "user",
              content: [
                filePart,
                { type: "text", text: `Original filename: ${doc.filename}` },
              ],
            },
          ],
        }),
      },
    );
    if (!res.ok)
      throw new Error(
        `${this.baseUrl} ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    const payload = (await res.json()) as ChatCompletion;
    return {
      ...readCompletion(payload, this.baseUrl, doc.readingLanguages),
      costUsd: payload.usage?.cost ?? null,
    };
  }
}

/** The OpenAI-shaped chat completion the backend answers with. */
type ChatCompletion = {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { cost?: number };
};

/**
 * Read a completion into the metadata and transcription it carries, along with
 * the stop reason that tells a transcription that ended from one that merely ran
 * out of room.
 */
function readCompletion(
  payload: ChatCompletion,
  baseUrl: string,
  readingLanguages: string[],
): Omit<EnrichResult, "costUsd"> {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string")
    throw new Error(`${baseUrl}: no content in response`);
  const { json, transcription } = splitResponse(content);
  return {
    meta: parseMetadata(json, readingLanguages),
    transcription,
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
  };
}

/**
 * Split a model response into the metadata JSON and the transcription after the
 * sentinel. Splitting on the first occurrence keeps the JSON safe even when the
 * marker turns up again inside the document's own text, and a response without the
 * sentinel is simply metadata and no transcription — which is how a model that
 * ignored the instruction degrades, instead of failing the whole enrichment.
 */
export function splitResponse(content: string): {
  json: string;
  transcription: string | null;
} {
  const at = content.indexOf(TRANSCRIPTION_SENTINEL);
  if (at === -1) return { json: content, transcription: null };
  const text = content.slice(at + TRANSCRIPTION_SENTINEL.length).trim();
  return { json: content.slice(0, at), transcription: text || null };
}

/** Strip markdown fences / surrounding prose down to the outermost JSON object. */
function coerceJsonObject(s: string): string {
  const trimmed = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    return start !== -1 && end > start
      ? trimmed.slice(start, end + 1)
      : trimmed;
  }
}

/**
 * Parse and normalize a model's JSON (tolerant of fences/prose) into
 * EnrichedMetadata. A title or summary written as one plain string, as a model
 * that ignored the per-language shape may write it, is taken to be in the first
 * Reading language: the one it was asked for first.
 */
export function parseMetadata(
  json: string,
  readingLanguages: string[] = [],
): EnrichedMetadata {
  const raw = JSON.parse(coerceJsonObject(json)) as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const party = (v: unknown): Party => {
    const p =
      typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    return {
      organization: String(p.organization ?? ""),
      person: String(p.person ?? ""),
    };
  };
  const deadlines = Array.isArray(raw.deadlines)
    ? (raw.deadlines as unknown[])
        .filter(
          (d): d is { label: unknown; date: unknown } =>
            typeof d === "object" && d !== null,
        )
        .map((d) => ({
          label: String(d.label ?? ""),
          date: String(d.date ?? ""),
        }))
    : [];
  const ref = Array.isArray(raw.ref)
    ? (raw.ref as unknown[])
        .filter(
          (r): r is { key: unknown; value: unknown } =>
            typeof r === "object" && r !== null,
        )
        .map((r) => ({
          key: String(r.key ?? ""),
          value: String(r.value ?? ""),
        }))
    : [];
  return {
    texts: textsOf(raw.title, raw.summary, readingLanguages[0]),
    people: arr(raw.people),
    sender: party(raw.sender),
    receiver: party(raw.receiver),
    deadlines,
    date: typeof raw.date === "string" && raw.date ? raw.date : null,
    languages: arr(raw.languages).map((l) => l.toUpperCase()),
    keywords: arr(raw.keywords),
    ref,
  };
}

/**
 * Pair a reading's titles and summaries by language. A language the model
 * wrote neither in is left out, so nothing claims a language it was not
 * written in.
 */
function textsOf(
  title: unknown,
  summary: unknown,
  first: string | undefined,
): Record<string, WrittenText> {
  const byLanguage = (v: unknown): Record<string, string> => {
    if (typeof v === "string") return first && v ? { [first]: v } : {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).map(([code, text]) => [
        code.trim().toUpperCase(),
        typeof text === "string" ? text : "",
      ]),
    );
  };
  const titles = byLanguage(title);
  const summaries = byLanguage(summary);
  const texts: Record<string, WrittenText> = {};
  for (const code of new Set([
    ...Object.keys(titles),
    ...Object.keys(summaries),
  ])) {
    const text = { title: titles[code] ?? "", summary: summaries[code] ?? "" };
    if (text.title || text.summary) texts[code] = text;
  }
  return texts;
}

/** A user's Provider as stored: where their Documents go, which model reads them, and the key. */
export type SavedProvider = {
  /** The endpoint, up to and including `/v1`. */
  baseUrl: string;
  /** The model id, as the endpoint names it. */
  model: string;
  /** Sent as a bearer token when set; a local server usually needs none. */
  apiKey: string | null;
  chosenAt: string;
};

/** What choosing a Provider names. A key left out is no key. */
export type ProviderChoice = {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
};

/** This user's Provider, or null while they have chosen none. */
export function savedProvider(
  lib: Library,
  userId: string,
): SavedProvider | null {
  const provider = lib.users.get(userId)?.provider;
  return provider ? { ...provider } : null;
}

/**
 * Choose this user's Provider, replacing the one they had. Nothing is read
 * again: Documents already Enriched keep the reading they have.
 */
export function saveProvider(
  lib: Library,
  userId: string,
  choice: ProviderChoice,
): void {
  const user = lib.users.get(userId);
  if (!user) throw new Error(`no user with id: ${userId}`);
  updateUser(lib, {
    ...user,
    provider: {
      baseUrl: choice.baseUrl,
      model: choice.model,
      apiKey: choice.apiKey || null,
      chosenAt: new Date().toISOString(),
    },
  });
}

/** Leave this user with no Provider, and so with no key. */
export function clearProvider(lib: Library, userId: string): void {
  const user = lib.users.get(userId);
  if (!user?.provider) return;
  updateUser(lib, { ...user, provider: null });
}
/**
 * The model ids an address offers, sorted, from its `GET /models`. Throws when
 * the address does not answer with a list, so an unreachable server is not
 * mistaken for one that offers nothing.
 */
export async function listModels(
  baseUrl: string,
  apiKey?: string | null,
): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`${baseUrl} answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  if (!Array.isArray(body?.data))
    throw new Error(`${baseUrl} did not answer with a list of models`);
  return (body.data as { id?: unknown }[])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id !== "")
    .sort();
}

/**
 * The key this user holds for this address: their own Provider's key, and only
 * for their own Provider's address, so a key is never sent somewhere it was not
 * given for. Null for any other address, or when no key is held.
 */
export function keyFor(
  lib: Library,
  userId: string,
  baseUrl: string,
): string | null {
  return keyAt(savedProvider(lib, userId), baseUrl);
}

/** The saved Provider's key if this is its address, else null. */
function keyAt(saved: SavedProvider | null, baseUrl: string): string | null {
  return saved?.baseUrl === baseUrl ? saved.apiKey : null;
}

/** Raised when a Document would be read but there is no Provider to read it. */
export class NoProvider extends Error {
  constructor() {
    super("there is no Provider to read the Documents");
  }
}

/** One run's departures from the saved Provider. None of them is saved. */
export type ProviderConfig = {
  baseUrl?: string;
  model?: string;
  /** For this run's address; without one, the saved key goes only to its own. */
  apiKey?: string;
};

/**
 * The Provider that reads a Document: the one saved by the user who asked for
 * the reading, with this run's overrides. There are no defaults: which server
 * reads a Document is a choice, never an assumption, so no saved Provider and
 * a run that names no complete one raise NoProvider. The saved key is sent
 * only to the address it was given for, so a run sent elsewhere never carries
 * it there.
 */
export function getProvider(
  saved: SavedProvider | null,
  cfg: ProviderConfig = {},
): EnrichmentProvider {
  const baseUrl = cfg.baseUrl ?? saved?.baseUrl;
  const model = cfg.model ?? saved?.model;
  if (!baseUrl || !model) throw new NoProvider();
  const apiKey = cfg.apiKey ?? keyAt(saved, baseUrl);
  return new ChatCompletionsProvider(baseUrl, model, apiKey || undefined);
}

export type EnrichOutcome =
  | {
      hash: string;
      status: "enriched";
      title: string;
      /** USD cost of the model call, when the backend reports it. */
      costUsd: number | null;
    }
  | {
      hash: string;
      /** Deleted while the provider was reading it; the reading was discarded. */
      status: "deleted";
      costUsd: number | null;
    };

/**
 * Enrich one document: the provider sees the stored file itself (vision) and returns
 * structured metadata plus a verbatim transcription. Idempotent — re-running
 * overwrites prior enrichment.
 *
 * The transcription is written before the Document's `document.yaml` flips to
 * 'enriched', so an enriched Document always has its transcription on disk. A
 * crash in between leaves the document 'imported', to be re-enriched and
 * overwritten. A
 * re-run that reads nothing back clears the old transcription rather than leaving
 * one model's text filed under another's name.
 *
 * The reading's Appearances are recorded last, and replace the Document's
 * previous ones: a second reading of one Document is still one Document, so a
 * name it no longer mentions stops appearing in it.
 *
 * A Document Deleted while the provider was reading it stays Deleted: finding
 * no `document.yaml` when it arrives, the reading is discarded, writing no
 * transcription and teaching the Library no names. The writes after that check
 * are synchronous, so a Delete in this process cannot land between them.
 */
export async function enrichDocument(
  lib: Library,
  doc: DocumentRecord,
  provider: EnrichmentProvider,
  readingLanguages: readonly string[] = DEFAULT_READING_LANGUAGES,
): Promise<EnrichOutcome> {
  const { meta, transcription, finishReason, costUsd } = await provider.enrich({
    path: objectPath(lib.root, doc.hash, doc.ext),
    mime: doc.mime,
    filename: doc.filename,
    readingLanguages: [...readingLanguages],
  });
  // From here on nothing awaits, so no Delete can land between this check and
  // the writes it allows.
  if (!getDocument(lib, doc.hash) || !documentFileExists(lib.root, doc.hash))
    return { hash: doc.hash, status: "deleted", costUsd };
  if (transcription) writeTranscription(lib.root, doc.hash, transcription);
  else removeTranscription(lib.root, doc.hash);
  updateEnrichment(
    lib,
    doc.hash,
    meta,
    { textSource: "vision", baseUrl: provider.baseUrl, model: provider.model },
    transcription
      ? {
          // A backend that reports no stop reason has not told us the reading
          // is complete, and "unknown" must not be recorded as "complete".
          truncated: finishReason === null ? null : finishReason === "length",
          finishReason,
          baseUrl: provider.baseUrl,
          model: provider.model,
          chars: transcription.length,
          createdAt: new Date().toISOString(),
        }
      : null,
  );
  const title = shownText(meta, readingLanguages)?.title ?? "";
  return { hash: doc.hash, status: "enriched", title, costUsd };
}
