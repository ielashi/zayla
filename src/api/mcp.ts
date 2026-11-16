/**
 * `/mcp`: the Library as an agent reads it, over MCP's Streamable HTTP
 * transport (ADR 0004). Every request carries an access token from oauth.ts
 * and is answered as that token's Connection's user. Nothing here writes: an
 * agent's instructions can come from text inside any Document it read.
 *
 * Each request gets its own server and transport, with no MCP session kept
 * between them: a token is all that says who is asking, so a request is
 * answered the same whichever server process, or restart, it reaches.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  type DocumentRecord,
  documentDate,
  findDocumentsByPrefix,
  type Library,
  listDocuments,
} from "../core/db.ts";
import { involvedIn } from "../core/entities.ts";
import { objectPath } from "../core/library.ts";
import { readingLanguagesOf, shownText } from "../core/reading-languages.ts";
import { searchLibrary } from "../core/search.ts";
import { readTranscription } from "../core/transcription.ts";
import { isCalendarDate } from "../dates.ts";
import type { Party } from "../shared.ts";
import {
  type Grants,
  PROTECTED_RESOURCE_PATH,
  tokenUser,
  withIssuer,
} from "./oauth.ts";

/** What the search tool tells an agent about how to use it. */
const SEARCH_DESCRIPTION = `Search the user's Zayla library of personal documents — letters, bills, contracts, scans — with Zayla's own search, the one its search box uses.

Every word of the query must match somewhere in a document: its title, summary, keywords, sender, receiver or transcription. So use a few distinctive words rather than a sentence. Titles and summaries are written in the user's reading languages, while keywords and transcriptions are in the document's own language.

When nothing is found, retry with synonyms and with translations into the languages the documents may be written in (for example "Mietvertrag" for "rental contract"). For a broad question, search more than once with different words.

Each result has the document's hash, its title in the user's reading languages (null for a document not yet read), its date, its sender and receiver, and, for a document found only through its transcription, the passage that matched.`;

/** What the get_document tool tells an agent it gives. */
const GET_DOCUMENT_DESCRIPTION = `Open one document of the user's Zayla library and get everything Zayla's model read out of it: its title and summary in each of the user's reading languages (and "title"/"summary" in the one the user is shown), the languages it is written in, its date, sender, receiver, deadlines and keywords, the people and organizations it involves with the part each played, which model read it at which address and when ("readBy"), and whether it has a transcription and whether that transcription is complete.

A document with "unread": true is still waiting to be read by a model: its fields are empty because nothing has been read out of it yet, not because the document is empty. Its original can still be opened with get_original.`;

/** What the get_transcription tool tells an agent it gives. */
const GET_TRANSCRIPTION_DESCRIPTION = `Read the transcription of one document of the user's Zayla library: what the document says, word for word, as a model read it, in the document's own language.

A transcription is a best-effort reading, so the original (get_original) is the authority on what the document says. "complete" is false when the model ran out of room and stopped before the document ended, so the text is missing its end; null when that is not known. "text" is null when the document has no transcription — it has not been read yet, or the model read nothing back.`;

/** What the get_original tool tells an agent it gives. */
const GET_ORIGINAL_DESCRIPTION = `Open the original file of one document of the user's Zayla library: the exact bytes that were filed, which are the authority on what the document says. An image comes back as an image; a PDF or any other file comes back as an embedded file with its media type.

Use it to check something the transcription may have misread, to read past where an incomplete transcription stops, or to look at a document that has not been read yet.`;

/** What the list_documents tool tells an agent it gives. */
const LIST_DOCUMENTS_DESCRIPTION = `List the documents of the user's Zayla library, newest first by each document's own date (the date on the letter, not when it was filed). Documents whose date is unknown come last.

Given "from" and/or "to" (yyyy-mm-dd, both ends included), only documents dated within that range are listed, so documents with no known date are left out. To find documents about something, use search instead.

Each entry has the document's hash, its title in the user's reading languages, its date, sender and receiver, and "unread": true for a document still waiting to be read by a model, whose title and other fields are therefore empty.`;

/** A Sender or Receiver as an agent is given one: a part left blank is null. */
const partyOut = (p: Party | null) =>
  p ? { organization: p.organization || null, person: p.person || null } : null;

/** What a tool answers with: `value` as JSON text. */
const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** A tool's answer that it could not do what it was asked, in words. */
const refusal = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** How every tool that opens one Document asks which. */
const HASH_INPUT = {
  hash: z
    .string()
    .describe(
      "The document's hash, as search or list_documents gives it, in full or its first 12 characters",
    ),
};

/** The one Document `ref` names, or what to tell the agent when it names none. */
function documentAt(
  lib: Library,
  ref: string,
): { doc: DocumentRecord } | { refused: ReturnType<typeof refusal> } {
  const asked = ref.trim().toLowerCase();
  const matches = asked ? findDocumentsByPrefix(lib, asked) : [];
  const [doc] = matches;
  if (doc && matches.length === 1) return { doc };
  return {
    refused: refusal(
      matches.length > 1
        ? `"${ref}" is the start of ${matches.length} documents' hashes; give more of it.`
        : `No document has the hash "${ref}". Search or list_documents gives each document's hash.`,
    ),
  };
}

/** Whether a Document is still waiting to be read, so has no Enrichment yet. */
const isUnread = (doc: DocumentRecord) =>
  doc.status === "imported" || doc.status === "needs_ocr";

/**
 * Whether a Transcription is known to be complete: false when the reading ran
 * out of room, null when that was never recorded.
 */
const isComplete = (doc: DocumentRecord) => {
  const truncated = doc.transcriptionProvenance?.truncated;
  return truncated == null ? null : !truncated;
};

/** A Document's whole Enrichment, as `get_document` gives it to `languages`' reader. */
async function enrichmentOut(
  lib: Library,
  doc: DocumentRecord,
  languages: readonly string[],
) {
  const shown = shownText(doc, languages);
  const model = doc.enrichModel ?? doc.enrichProvider;
  return {
    hash: doc.hash,
    filename: doc.filename,
    mediaType: doc.mime,
    unread: isUnread(doc),
    title: shown?.title ?? null,
    summary: shown?.summary || null,
    texts: Object.fromEntries(
      languages.flatMap((code) => {
        const text = doc.texts[code];
        return text?.title
          ? [[code, { title: text.title, summary: text.summary || null }]]
          : [];
      }),
    ),
    languages: doc.languages ?? [],
    date: documentDate(doc),
    dateSetByOwner: doc.owner !== null,
    sender: partyOut(doc.sender),
    receiver: partyOut(doc.receiver),
    deadlines: doc.deadlines ?? [],
    keywords: doc.keywords ?? [],
    involved: involvedIn(lib, doc.hash).map((e) => ({
      kind: e.kind,
      name: e.displayName,
      roles: e.roles,
      actingFor: e.affiliations.map((org) => org.displayName),
    })),
    readBy:
      model || doc.enrichBaseUrl || doc.enrichedAt
        ? { model, address: doc.enrichBaseUrl, at: doc.enrichedAt }
        : null,
    transcription: {
      exists: (await readTranscription(lib.root, doc.hash)) !== null,
      complete: isComplete(doc),
    },
  };
}

/**
 * A Document's Original, as MCP carries a file: an image as an image, which a
 * model can look at, and anything else as an embedded file at the address
 * Zayla serves it from.
 */
async function originalOut(lib: Library, doc: DocumentRecord, issuer: string) {
  const bytes = await Bun.file(objectPath(lib.root, doc.hash, doc.ext)).bytes();
  const data = Buffer.from(bytes).toString("base64");
  return {
    content: [
      doc.mime.startsWith("image/")
        ? { type: "image" as const, mimeType: doc.mime, data }
        : {
            type: "resource" as const,
            resource: {
              uri: `${issuer}/api/documents/${doc.hash}/original`,
              mimeType: doc.mime,
              blob: data,
            },
          },
    ],
  };
}

/**
 * Documents newest first by their own date, as the gallery's Newest sorts
 * them: an undated one last, since an unknown date is not an old one. Given a
 * range, only the Documents dated within it, both ends included.
 */
function documentsWithin(
  lib: Library,
  from: string | undefined,
  to: string | undefined,
): DocumentRecord[] {
  const ranged = from !== undefined || to !== undefined;
  return listDocuments(lib)
    .filter((doc) => {
      const date = documentDate(doc);
      if (!ranged) return true;
      return (
        date !== null &&
        (from === undefined || date >= from) &&
        (to === undefined || date <= to)
      );
    })
    .sort((a, b) => {
      const [x, y] = [documentDate(a), documentDate(b)];
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      return y.localeCompare(x);
    });
}

/** A day an agent names, checked as Zayla keeps dates. */
const DAY = z
  .string()
  .refine(isCalendarDate, "a day written yyyy-mm-dd, such as 2024-03-01");

/** The MCP server for one request, reading as `userId`, opened at `issuer`. */
function libraryServer(
  lib: Library,
  userId: string,
  issuer: string,
): McpServer {
  const server = new McpServer({ name: "zayla", version: "1.0.0" });
  server.registerTool(
    "search",
    {
      title: "Search documents",
      description: SEARCH_DESCRIPTION,
      inputSchema: { query: z.string().describe("The words to search for") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query }) => {
      const languages = readingLanguagesOf(lib, userId);
      const results = searchLibrary(lib, query).flatMap((hit) => {
        const doc = lib.documents.get(hit.hash);
        if (!doc) return [];
        return [
          {
            hash: hit.hash,
            title: shownText(doc, languages)?.title ?? null,
            date: documentDate(doc),
            sender: partyOut(doc.sender),
            receiver: partyOut(doc.receiver),
            snippet: hit.snippet?.text ?? null,
          },
        ];
      });
      return json({ results });
    },
  );
  server.registerTool(
    "get_document",
    {
      title: "Open a document's details",
      description: GET_DOCUMENT_DESCRIPTION,
      inputSchema: HASH_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hash }) => {
      const found = documentAt(lib, hash);
      if ("refused" in found) return found.refused;
      return json(
        await enrichmentOut(lib, found.doc, readingLanguagesOf(lib, userId)),
      );
    },
  );
  server.registerTool(
    "get_transcription",
    {
      title: "Read a document's transcription",
      description: GET_TRANSCRIPTION_DESCRIPTION,
      inputSchema: HASH_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hash }) => {
      const found = documentAt(lib, hash);
      if ("refused" in found) return found.refused;
      const { doc } = found;
      const text = await readTranscription(lib.root, doc.hash);
      const complete = text === null ? null : isComplete(doc);
      const answer = json({ hash: doc.hash, text, complete });
      if (complete === false)
        answer.content.push({
          type: "text",
          text: "This transcription is incomplete: the model stopped reading before the document ended. The original, from get_original, has the rest.",
        });
      return answer;
    },
  );
  server.registerTool(
    "get_original",
    {
      title: "Open a document's original file",
      description: GET_ORIGINAL_DESCRIPTION,
      inputSchema: HASH_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hash }) => {
      const found = documentAt(lib, hash);
      if ("refused" in found) return found.refused;
      return originalOut(lib, found.doc, issuer);
    },
  );
  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: LIST_DOCUMENTS_DESCRIPTION,
      inputSchema: {
        from: DAY.optional().describe(
          "The earliest document date to include, yyyy-mm-dd",
        ),
        to: DAY.optional().describe(
          "The latest document date to include, yyyy-mm-dd",
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ from, to }) => {
      const languages = readingLanguagesOf(lib, userId);
      const documents = documentsWithin(lib, from, to).map((doc) => ({
        hash: doc.hash,
        title: shownText(doc, languages)?.title ?? null,
        date: documentDate(doc),
        sender: partyOut(doc.sender),
        receiver: partyOut(doc.receiver),
        unread: isUnread(doc),
      }));
      return json({ documents });
    },
  );
  return server;
}

/** The bearer token a request carries, or null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** The answer to a request carrying no token this server issued (RFC 9728 §5.1). */
const unauthorized = (issuer: string) =>
  Response.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${issuer}${PROTECTED_RESOURCE_PATH}"`,
      },
    },
  );

async function answer(
  lib: Library,
  grants: Grants,
  req: Request,
  issuer: string,
): Promise<Response> {
  const token = bearerToken(req);
  const userId = token ? tokenUser(lib, grants, token) : null;
  if (!userId) return unauthorized(issuer);
  // Without sessions there is no stream to hold open for the server to speak
  // first, and nothing to end.
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const server = libraryServer(lib, userId, issuer);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

/** The `/mcp` route over this Library, for the tokens in `grants`. */
export function mcpRoutes(lib: Library, grants: Grants) {
  const handle = withIssuer((req, issuer) => answer(lib, grants, req, issuer));
  return { "/mcp": { GET: handle, POST: handle, DELETE: handle } };
}
