import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import index from "../index.html";
import { authRoutes } from "./api/auth.ts";
import {
  addressAndModel,
  httpAddress,
  modelsAt,
  noAddressToList,
} from "./api/provider-form.ts";
import { setupRoutes } from "./api/setup.ts";
import { browseView } from "./browse.ts";
import { countUsers, requireAuth } from "./core/auth.ts";
import type { Library } from "./core/db.ts";
import {
  type DocumentRecord,
  findDocumentsByPrefix,
  getDocument,
  listDocuments,
} from "./core/db.ts";
import {
  clearProvider,
  enrichDocument,
  getProvider,
  keyFor,
  NoProvider,
  savedProvider,
  saveProvider,
} from "./core/enrich.ts";
import {
  type EntityDetail,
  entityById,
  entityDetail,
  listEntities,
  markedAsMe,
  markMe,
  mergeEntities,
  Refused,
  suggestDuplicates,
  unmergeEntity,
} from "./core/entities.ts";
import { deleteFile, importFile, NoDocument } from "./core/ingest.ts";
import { objectPath, pagePath, thumbPath } from "./core/library.ts";
import {
  readingLanguagesOf,
  setReadingLanguages,
  shownText,
} from "./core/reading-languages.ts";
import { pageCounter, renderPage, renderThumbnail } from "./core/render.ts";
import { searchLibrary } from "./core/search.ts";
import { newSetupCode } from "./core/setup.ts";
import { readTranscription } from "./core/transcription.ts";
import { readingLanguagesFrom } from "./languages.ts";
import {
  DESTINATION_PATHS,
  ENTITY_PATH_PATTERNS,
  entityId,
  resolveRoute,
} from "./routes.ts";
import type {
  ApiDocument,
  ApiEntity,
  ApiEntityPage,
  ApiProvider,
} from "./shared.ts";

/** The answer to a request carrying no valid session, wherever the gate is. */
const unauthorized = () =>
  Response.json({ error: "unauthorized" }, { status: 401 });

/**
 * Gate a request: returns a 401 Response when it carries no valid session, else
 * null (proceed).
 *
 * A handler that needs to know *who* is asking — and not only that somebody is,
 * which is all most of them are about — calls `requireAuth` itself instead, and answers with the same `unauthorized`.
 */
function guard(lib: Library, req: Request): Response | null {
  return requireAuth(lib, req) ? null : unauthorized();
}

/** This user's Provider as Settings shows it: whether a key is held, never the key. */
function apiProviderOf(lib: Library, userId: string): ApiProvider | null {
  const p = savedProvider(lib, userId);
  return p
    ? {
        baseUrl: p.baseUrl,
        model: p.model,
        hasKey: p.apiKey !== null,
        chosenAt: p.chosenAt,
      }
    : null;
}

/**
 * Shape the stored record into the wire contract the gallery consumes
 * (`ApiDocument`, defined in shared.ts), for a user who reads in these
 * languages: of the titles and summaries the Document has, it carries the one
 * that user is shown. `ref` is flattened to [key, value] pairs for the UI.
 */
function toApi(
  d: DocumentRecord,
  readingLanguages: readonly string[],
  pages: number | null,
): ApiDocument {
  const shown = shownText(d, readingLanguages);
  return {
    hash: d.hash,
    filename: d.filename,
    mime: d.mime,
    ext: d.ext,
    bytes: d.bytes,
    addedAt: d.addedAt,
    status: d.status,
    // extracted (null / [] until enriched)
    title: shown?.title ?? null,
    people: d.people ?? [],
    date: d.docDate,
    languages: d.languages ?? [],
    keywords: d.keywords ?? [],
    summary: shown?.summary || null,
    ref: (d.ref ?? []).map((r) => [r.key, r.value]),
    sender: d.sender,
    receiver: d.receiver,
    deadlines: d.deadlines ?? [],
    pages,
  };
}

/** Shape one entity's detail into the wire contract its page consumes. */
function toApiEntityPage(d: EntityDetail): ApiEntityPage {
  return {
    id: d.id,
    kind: d.kind,
    displayName: d.displayName,
    documents: d.documents,
    variants: d.variants,
    affiliations: d.affiliations,
    mergedNames: d.mergedNames,
    suspected: d.suspected.map(toApiEntity),
    roles: d.documentsByRole,
  };
}

/** One entity as the page and the Merge answers carry it: named, and counted. */
const toApiEntity = (e: {
  id: number;
  displayName: string;
  documents: number;
}): ApiEntity => ({
  id: e.id,
  displayName: e.displayName,
  documents: e.documents,
});

/**
 * Answer a statement about naming the Library would not make: a Merge it
 * refuses, or a Person it will not call Me. A refusal is the request's fault
 * and carries the domain's own words for the page that asked to show; anything
 * else is the Library failing to answer, which is not something the owner did
 * and is not reported to them as though it were.
 */
const statementRefused = (err: unknown) =>
  Response.json(
    { error: (err as Error).message },
    { status: err instanceof Refused ? 400 : 500 },
  );

/**
 * The entity id a request body names, or null when it names none. The ids a
 * Merge is made from come from the Library's own lists, so anything that is not
 * one of those is the request's fault rather than a name to go looking for.
 */
function bodyEntityId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Import one uploaded file: write the blob to a temp file (importFile takes a
 * path, not bytes), catalog it, and return the gallery record plus the dedupe
 * flag. `basename` keeps a crafted file.name from escaping the temp dir.
 */
async function importUpload(
  lib: Library,
  file: File,
  readingLanguages: readonly string[],
  pagesOf: PagesOf,
): Promise<Record<string, unknown> & { deduped: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "zayla-upload-"));
  try {
    const dest = join(dir, basename(file.name) || "upload");
    await Bun.write(dest, file);
    const result = await importFile(lib, dest);
    const rec = getDocument(lib, result.hash);
    if (!rec) throw new Error("import succeeded but record vanished");
    return {
      ...toApi(rec, readingLanguages, await pagesOf(rec)),
      deduped: result.deduped,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The page a mistyped address gets, and the only place these words live: the
 * application itself never renders a not-found view, because it is only ever
 * served at a registered path. It carries no palette of its own on purpose — the
 * tokens live in index.html's stylesheet, and restating them here would leave a
 * copy to drift. Layout only, so a dead end looks deliberate, not broken.
 */
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Not found · Zayla</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; line-height: 1.5; text-align: center; }
  h1 { font-weight: 600; font-size: 22px; margin: 0 0 8px; }
  p { font-size: 14px; margin: 0 0 20px; }
</style>
</head>
<body>
<main>
  <h1>There's nothing at this address</h1>
  <p>The address you asked for isn't part of your library.</p>
  <a href="/">Back to your documents</a>
</main>
</body>
</html>
`;

/** The answer a mistyped address gets, which is the only answer it gets. */
const notFoundPage = () =>
  new Response(NOT_FOUND_PAGE, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

/**
 * The application shell, for an address that had to be checked before being
 * answered. It is Bun's bundle of index.html, which a route can hand back only
 * as a route *value* — a handler cannot return it — so this asks the server for
 * its own root and passes that answer on.
 *
 * The request goes to the address the server itself listens on, never to the one
 * in `req.url`: Zayla runs behind a reverse proxy, whose Host header would
 * send this back out through the tunnel and in through the front door.
 */
async function applicationShell(
  server: Bun.Server<undefined>,
): Promise<Response> {
  const shell = await fetch(new URL("/", server.url));
  return new Response(shell.body, {
    status: shell.status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Answer an entity's address: the application shell when the Library holds that
 * entity, and the not-found page when it does not. Unlike every other address
 * the shell is served at, this one exists only while its entity does, so it is
 * the one address the server has to look up before answering. The alternative is
 * serving the shell at every `/people/<anything>`, which would leave the
 * application rendering a dead end that it has no business knowing about.
 *
 * Which entities the Library holds is the owner's business, though, so the
 * lookup only answers a request that carries a session. Without one the shell is
 * served whatever the address and the gate asks who is there: telling a stranger
 * that one address is a page and the next is nothing would hand them the ids the
 * Library holds, one request at a time.
 */
async function entityPage(
  lib: Library,
  req: Request,
  server: Bun.Server<undefined>,
): Promise<Response> {
  const route = resolveRoute(new URL(req.url).pathname);
  if (route.at !== "entity") return notFoundPage();

  let held: boolean;
  if (!requireAuth(lib, req)) held = true;
  else {
    const found = entityDetail(lib, route.id);
    // An Organization is not at a Person's address: one entity, one address.
    held = found !== null && found.kind === route.kind;
  }
  return held ? applicationShell(server) : notFoundPage();
}

/**
 * The icons public/manifest.webmanifest names, at the paths it names them by.
 * The shell's own `<link>`s — the manifest, the favicon, the Apple touch icon —
 * are bundled with index.html and served at hashed paths, but the bundler
 * copies the manifest without reading it, so the icons inside it need addresses
 * that never change. They say nothing about the Library, and a phone asks for
 * them while adding the sign-in page to its home screen, so they are served to
 * anyone.
 */
const MANIFEST_ICONS: Record<string, string> = {
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "icon.svg": "image/svg+xml",
};

function manifestIcons(): Record<string, Response> {
  return Object.fromEntries(
    Object.entries(MANIFEST_ICONS).map(([name, type]) => [
      `/${name}`,
      new Response(Bun.file(join(import.meta.dir, "..", "public", name)), {
        headers: { "Content-Type": type },
      }),
    ]),
  );
}

/**
 * The Setup code for this boot: a fresh one, printed to the logs, while the
 * Library has no user; null, and nothing printed, once it has one.
 */
function setupCodeForBoot(lib: Library): string | null {
  if (countUsers(lib) > 0) return null;
  const code = newSetupCode();
  console.log(`This Library has no owner yet. Setup code: ${code}`);
  return code;
}

/** How many pages a Document has (see pageCounter in render.ts). */
type PagesOf = ReturnType<typeof pageCounter>;

/** Start the local gallery server: serves index.html + the library's data and files. */
export function startServer(port: number, lib: Library) {
  const setupCode = setupCodeForBoot(lib);
  const pagesOf = pageCounter(lib.root);
  return Bun.serve({
    port,
    routes: {
      // One registration per destination in routes.ts, so every address the
      // sidebar offers is a real path that can be reloaded and bookmarked — and
      // so no other path reaches the application shell.
      ...Object.fromEntries(DESTINATION_PATHS.map((path) => [path, index])),

      // An entity's page, one pattern per kind. Which ids exist is the
      // Library's business and changes as Documents are read, so these are the
      // only addresses answered by a lookup rather than by registration.
      ...Object.fromEntries(
        ENTITY_PATH_PATTERNS.map((pattern) => [
          pattern,
          (req: Request, server: Bun.Server<undefined>) =>
            entityPage(lib, req, server),
        ]),
      ),

      // Who the Library's Documents involve, arranged for browsing: the
      // Organization spine, the People belonging to no Organization, and the
      // sidebar's shortcuts. One endpoint because they are one reading of one
      // list — and because the sidebar needs the shortcuts whichever
      // destination is being viewed, including the Document view.
      //
      // That list is the same for everyone, but which of the People is Me is
      // not, so this one reads the session for the user rather than only for
      // the gate.
      "/api/entities": {
        GET: (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          // One listing, read once: the lists, the shortcuts and the pairs
          // that look like one name all come off it, so a flagged pair can
          // never name a row the lists do not have.
          const listed = listEntities(lib);
          return Response.json(
            browseView(
              listed,
              suggestDuplicates(listed),
              markedAsMe(lib, user.id),
            ),
          );
        },
      },

      // One entity as its own page shows it. The Documents come back as hashes:
      // the gallery already holds the Library's Documents, so the page draws
      // the same cards from the same source rather than a second copy of them.
      "/api/entities/:id": {
        GET: (req) => {
          const denied = guard(lib, req);
          if (denied) return denied;
          const id = entityId(req.params.id);
          if (id === null) return new Response("not found", { status: 404 });
          const found = entityDetail(lib, id);
          return found
            ? Response.json(toApiEntityPage(found))
            : new Response("not found", { status: 404 });
        },
      },

      // The Merges: the owner's statements that two names are one. A Merge is a
      // statement about naming rather than about either entity — it is
      // symmetric, see ADR-0002 — so it is addressed as a thing of its own
      // rather than as something done to one of the two names.
      //
      // A refusal comes back as 400 carrying the reason the domain gives: two
      // names of different kinds, two names already one, a spelling a third
      // name holds, an id that is nobody's. The dialog that asked shows what it
      // says, so the owner reads the Library's own words rather than a status
      // code's — and a Library that failed to answer is a 500, not a reason the
      // owner's request was wrong.
      "/api/merges": {
        POST: async (req) => {
          const denied = guard(lib, req);
          if (denied) return denied;
          const body = (await req.json().catch(() => null)) as {
            a?: unknown;
            b?: unknown;
            displayName?: unknown;
          } | null;
          const a = bodyEntityId(body?.a);
          const b = bodyEntityId(body?.b);
          if (a === null || b === null)
            return Response.json(
              { error: "a merge needs two persons or organizations, by id" },
              { status: 400 },
            );
          // The owner's choice of displayed name, when they made one. Omitted
          // leaves the most frequent variant standing, which is the Library's
          // judgement and not the browser's to reproduce.
          const displayName =
            typeof body?.displayName === "string" && body.displayName.trim()
              ? body.displayName
              : undefined;
          try {
            const { survivor, absorbed } = mergeEntities(lib, a, b, {
              displayName,
            });
            return Response.json({
              survivor: toApiEntity(survivor),
              absorbed,
            });
          } catch (err) {
            return statementRefused(err);
          }
        },
      },

      // Take one Merge back. A Merge is named by the name it took in, which is
      // the one thing that identifies it: the surviving name may have taken in
      // several, and each can be given back on its own.
      "/api/merges/:absorbed": {
        DELETE: (req) => {
          const denied = guard(lib, req);
          if (denied) return denied;
          const absorbed = entityId(req.params.absorbed);
          if (absorbed === null)
            return new Response("not found", { status: 404 });
          try {
            const { survivor, restored } = unmergeEntity(lib, absorbed);
            return Response.json({
              survivor: toApiEntity(survivor),
              restored: toApiEntity(restored),
            });
          } catch (err) {
            return statementRefused(err);
          }
        },
      },

      // Mark this Person as Me — the one thing the Library keeps per user, and
      // so the other endpoint that reads the session for who is asking. The
      // answer carries the Person that answers for Me now, by which the lists
      // label the reader's own row.
      //
      // An id that is nobody's is nothing here, exactly as it is on the way in
      // — the address of a page the Library does not have. An id that names
      // something it cannot be is a different answer: the address is real, and
      // what it was asked to do is what could not be done, so it is refused in
      // the domain's own words, by the one rule every refusal comes through.
      "/api/entities/:id/me": {
        POST: (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const id = entityId(req.params.id);
          const named = id === null ? null : entityById(lib, id);
          if (named === null) return new Response("not found", { status: 404 });
          try {
            return Response.json({ me: markMe(lib, user.id, named.id) });
          } catch (err) {
            return statementRefused(err);
          }
        },
      },

      // The asking user's Provider: each user chooses their own, and the
      // Documents they ask to have read go to it. Like Me, these read the
      // session for who is asking. Its key is taken in and never handed back;
      // Settings is told only that one is held.
      "/api/provider": {
        GET: (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          return Response.json({ provider: apiProviderOf(lib, user.id) });
        },
        // Choose the Provider. A key left out keeps the one held, but only
        // for the address it was given for: a different address starts with
        // none, so a key is never sent somewhere it was not meant for. A null
        // or empty key removes it.
        PUT: async (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const body = (await req.json().catch(() => null)) as {
            baseUrl?: unknown;
            model?: unknown;
            apiKey?: unknown;
          } | null;
          const named = addressAndModel(body);
          if ("error" in named)
            return Response.json({ error: named.error }, { status: 400 });
          const { baseUrl, model } = named;
          let apiKey: string | null;
          if (body?.apiKey === undefined)
            apiKey = keyFor(lib, user.id, baseUrl);
          else if (typeof body.apiKey === "string") apiKey = body.apiKey.trim();
          else apiKey = null;
          saveProvider(lib, user.id, { baseUrl, model, apiKey });
          return Response.json({ provider: apiProviderOf(lib, user.id) });
        },
        DELETE: (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          clearProvider(lib, user.id);
          return Response.json({ provider: null });
        },
      },

      // The asking user's Reading languages: the 1 to 4 languages, in order
      // of preference, their Documents are read into and shown in. Changing
      // them reads nothing again and discards nothing written.
      "/api/reading-languages": {
        GET: (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          return Response.json({
            languages: readingLanguagesOf(lib, user.id),
          });
        },
        PUT: async (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const body = (await req.json().catch(() => null)) as {
            languages?: unknown;
          } | null;
          const chosen = readingLanguagesFrom(body?.languages);
          if ("error" in chosen)
            return Response.json({ error: chosen.error }, { status: 400 });
          setReadingLanguages(lib, user.id, chosen.languages);
          return Response.json({
            languages: readingLanguagesOf(lib, user.id),
          });
        },
      },

      // The models an address offers, for Settings to choose from before the
      // Provider is saved — so the address and key come in the body, not the
      // query string. Without a key, the one the asking user holds for that
      // same address is used.
      "/api/provider/models": {
        POST: async (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const body = (await req.json().catch(() => null)) as {
            baseUrl?: unknown;
            apiKey?: unknown;
          } | null;
          const baseUrl = httpAddress(body?.baseUrl);
          if (!baseUrl) return noAddressToList();
          const apiKey =
            (typeof body?.apiKey === "string" ? body.apiKey.trim() : "") ||
            keyFor(lib, user.id, baseUrl);
          return modelsAt(baseUrl, apiKey);
        },
      },

      // The Documents are the same for everyone, but which of each one's
      // titles is shown is not: each user is shown theirs in their own
      // Reading languages, so these read the session for who is asking.
      "/api/documents": {
        GET: async (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const languages = readingLanguagesOf(lib, user.id);
          return Response.json(
            await Promise.all(
              listDocuments(lib).map(async (d) =>
                toApi(d, languages, await pagesOf(d)),
              ),
            ),
          );
        },

        // Upload one or more files (multipart, field "files"): each is imported
        // (fast); enrichment is a separate call per doc so the UI can show
        // progress. Returns one item per file — a gallery record on success,
        // or { filename, error } when that file failed.
        POST: async (req) => {
          let languages: string[];
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          languages = readingLanguagesOf(lib, user.id);
          const form = await req.formData();
          const files = form.getAll("files").filter((f) => f instanceof File);
          if (files.length === 0)
            return Response.json(
              { error: "no files in upload (field 'files')" },
              { status: 400 },
            );
          const results = await Promise.all(
            files.map(async (file) => {
              try {
                return await importUpload(lib, file, languages, pagesOf);
              } catch (err) {
                return { filename: file.name, error: (err as Error).message };
              }
            }),
          );
          return Response.json(results);
        },
      },

      // Search the whole Library: every term of `q` must match somewhere in a
      // Document, its Transcription included. An empty query finds nothing,
      // because the gallery shows the whole Library without asking.
      "/api/search": {
        GET: (req) => {
          const denied = guard(lib, req);
          if (denied) return denied;
          const query = new URL(req.url).searchParams.get("q") ?? "";
          return Response.json(searchLibrary(lib, query));
        },
      },

      // Delete one Document, permanently: there is no trash and no undo. Unlike
      // the read-only routes beside it, this takes the full hash and never a
      // prefix, so nothing is ever Deleted by a short hash that happened to
      // match.
      "/api/documents/:hash": {
        DELETE: async (req) => {
          const denied = guard(lib, req);
          if (denied) return denied;
          try {
            const { hash, filename } = await deleteFile(lib, req.params.hash);
            return Response.json({ hash, filename });
          } catch (err) {
            if (err instanceof NoDocument)
              return new Response("not found", { status: 404 });
            throw err;
          }
        },
      },

      // Enrich one document (vision model call — slow). Errors (unsupported
      // type, model failure) come back as { error } so the card can show a
      // retry affordance instead of the request hanging. The Document goes to
      // the Provider of the user who asked for it to be read. A user with no
      // Provider is not an error but a state: a 409 carrying `noProvider`,
      // and the Document stays filed, waiting to be read.
      "/api/documents/:hash/enrich": {
        POST: async (req) => {
          const user = requireAuth(lib, req);
          if (!user) return unauthorized();
          const matches = findDocumentsByPrefix(lib, req.params.hash);
          const d = matches.length === 1 ? matches[0] : undefined;
          if (!d) return new Response("not found", { status: 404 });
          let provider: ReturnType<typeof getProvider>;
          try {
            provider = getProvider(savedProvider(lib, user.id));
          } catch (err) {
            if (!(err instanceof NoProvider)) throw err;
            return Response.json(
              { error: err.message, noProvider: true },
              { status: 409 },
            );
          }
          const languages = readingLanguagesOf(lib, user.id);
          try {
            const outcome = await enrichDocument(lib, d, provider, languages);
            if (outcome.costUsd != null)
              console.info(
                `${outcome.status} ${d.hash.slice(0, 8)} via ${provider.model} at ${provider.baseUrl}: $${outcome.costUsd.toFixed(4)}`,
              );
          } catch (err) {
            return Response.json(
              { error: (err as Error).message },
              { status: 500 },
            );
          }
          // Deleted while it was being read: the reading was discarded, and
          // there is nothing to show for it.
          const updated = getDocument(lib, d.hash);
          if (!updated) return new Response("not found", { status: 404 });
          return Response.json(
            toApi(updated, languages, await pagesOf(updated)),
          );
        },
      },

      // The original file, streamed inline (detail panel's "Open original").
      "/api/documents/:hash/original": (req) => {
        const denied = guard(lib, req);
        if (denied) return denied;
        const matches = findDocumentsByPrefix(lib, req.params.hash);
        const d = matches.length === 1 ? matches[0] : undefined;
        if (!d) return new Response("not found", { status: 404 });
        return new Response(Bun.file(objectPath(lib.root, d.hash, d.ext)), {
          headers: {
            "Content-Type": d.mime,
            "Content-Disposition": `inline; filename="${encodeURIComponent(d.filename)}"`,
          },
        });
      },

      // The first-page thumbnail, rendered on first request (PDFs) and cached
      // under library/derived/<hash>/. 404 → the card keeps its placeholder.
      "/api/documents/:hash/thumb": async (req) => {
        const denied = guard(lib, req);
        if (denied) return denied;
        const matches = findDocumentsByPrefix(lib, req.params.hash);
        const d = matches.length === 1 ? matches[0] : undefined;
        if (!d) return new Response("not found", { status: 404 });

        const cached = thumbPath(lib.root, d.hash);
        if (await Bun.file(cached).exists()) {
          return new Response(Bun.file(cached), {
            headers: { "Content-Type": "image/jpeg" },
          });
        }
        if (d.mime === "application/pdf") {
          try {
            await renderThumbnail(
              lib.root,
              objectPath(lib.root, d.hash, d.ext),
              d.hash,
            );
          } catch {
            return new Response("not found", { status: 404 }); // poppler missing / render failed
          }
          return new Response(Bun.file(cached), {
            headers: { "Content-Type": "image/jpeg" },
          });
        }
        if (d.mime.startsWith("image/")) {
          // An image is its own thumbnail.
          return new Response(Bun.file(objectPath(lib.root, d.hash, d.ext)), {
            headers: { "Content-Type": d.mime },
          });
        }
        return new Response("not found", { status: 404 });
      },

      // One page of a Document (1-based), for the viewer: a PDF's rendered on
      // first request to a JPEG about 1600px wide, a Derived artifact kept
      // under library/derived/<hash>/ beside the thumbnail; an image is its own one
      // page. 404 for a page it doesn't have, or one that couldn't be rendered,
      // so the viewer shows its placeholder in that page's place.
      "/api/documents/:hash/pages/:n": async (req) => {
        const denied = guard(lib, req);
        if (denied) return denied;
        const matches = findDocumentsByPrefix(lib, req.params.hash);
        const d = matches.length === 1 ? matches[0] : undefined;
        if (!d) return new Response("not found", { status: 404 });
        const n = /^[1-9]\d*$/.test(req.params.n) ? Number(req.params.n) : 0;
        const pages = await pagesOf(d);
        if (pages === null || n < 1 || n > pages)
          return new Response("not found", { status: 404 });

        const original = objectPath(lib.root, d.hash, d.ext);
        if (d.mime.startsWith("image/"))
          return new Response(Bun.file(original), {
            headers: { "Content-Type": d.mime },
          });
        const rendered = pagePath(lib.root, d.hash, n);
        if (!(await Bun.file(rendered).exists())) {
          try {
            await renderPage(lib.root, original, d.hash, n);
          } catch {
            return new Response("not found", { status: 404 }); // poppler missing / render failed
          }
        }
        return new Response(Bun.file(rendered), {
          headers: { "Content-Type": "image/jpeg" },
        });
      },

      // The transcription — the model's word-for-word reading of the document,
      // stored under library/about/<hash>/. 404 when the document has none, which
      // is normal: enrichment may predate transcriptions, or the model read nothing.
      "/api/documents/:hash/transcription": async (req) => {
        const denied = guard(lib, req);
        if (denied) return denied;
        const matches = findDocumentsByPrefix(lib, req.params.hash);
        const d = matches.length === 1 ? matches[0] : undefined;
        if (!d) return new Response("not found", { status: 404 });
        const text = await readTranscription(lib.root, d.hash);
        if (text === null) return new Response("not found", { status: 404 });
        return new Response(text, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },

      // The icons the web app manifest names, served to anyone.
      ...manifestIcons(),

      // Authentication ceremony endpoints (WebAuthn / passkeys).
      ...authRoutes(lib),

      // First-run Setup, open only while the Library has no user.
      ...setupRoutes(lib, setupCode),
    },

    // Every address the application answers on is registered above, so anything
    // reaching here is a genuine miss. It is told so in words rather than served
    // the shell: this is how a typo reports itself, not a catch-all route.
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/api/"))
        return new Response("not found", { status: 404 });
      return notFoundPage();
    },

    // Bundled on request with hot reloading while developing; built once,
    // minified, when the image runs with NODE_ENV=production.
    development: process.env.NODE_ENV !== "production" && { hmr: true },
    // Enrichment holds a request open while the model works — a cloud vision
    // call, or a local server loading a multi-GB model on first use — with no
    // bytes flowing to the client meanwhile. Bun's 10s default kills that; use the max (255s).
    idleTimeout: 255,
  });
}
