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
import { documentDate, type Library } from "../core/db.ts";
import { readingLanguagesOf, shownText } from "../core/reading-languages.ts";
import { searchLibrary } from "../core/search.ts";
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

/** A Sender or Receiver as an agent is given one: a part left blank is null. */
const partyOut = (p: Party | null) =>
  p ? { organization: p.organization || null, person: p.person || null } : null;

/** The MCP server for one request, reading as `userId`. */
function libraryServer(lib: Library, userId: string): McpServer {
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
      return {
        content: [{ type: "text", text: JSON.stringify({ results }) }],
      };
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
  const server = libraryServer(lib, userId);
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
