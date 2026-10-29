#!/usr/bin/env bun
import {
  clearAllAuth,
  hasPassword,
  isAcceptablePassword,
  listCredentialsForUser,
  listUsers,
  PASSWORD_RULE,
  setPassword,
} from "./core/auth.ts";
import type { Library } from "./core/db.ts";
import {
  closeLibrary,
  type DocumentRecord,
  findDocumentsByPrefix,
  getDocument,
  listDocuments,
  listPending,
  openLibrary,
} from "./core/db.ts";
import {
  enrichDocument,
  getProvider,
  type ProviderConfig,
  type SavedProvider,
  savedProvider,
} from "./core/enrich.ts";
import {
  type DuplicateSuggestion,
  type EntityListing,
  type EntityRef,
  findEntities,
  listEntities,
  mergeEntities,
  type NamedEntity,
  suggestDuplicates,
  unmergeEntity,
} from "./core/entities.ts";
import { deleteFile, importFile } from "./core/ingest.ts";
import { libraryRoot } from "./core/library.ts";
import { LibraryLocked, type LockHolder, SERVER } from "./core/lock.ts";
import { readingLanguagesOf, shownText } from "./core/reading-languages.ts";
import { DEFAULT_READING_LANGUAGES } from "./languages.ts";

const USAGE = `zayla

Usage:
  zayla import <file>    Ingest a document into the library
  zayla enrich [<hash>] [--base-url U] [--model M] [--api-key K]
                             Send documents to a vision model & index metadata
                             (all pending if no hash)
  zayla show <hash>      Print a document's full record (hash or 12-char prefix)
  zayla list             List catalogued documents
  zayla entities         List the persons & organizations the documents
                             involve, and the names that look like duplicates
  zayla merge <a> <b> [--name N]
                             Say that two names are the same person, or the same
                             organization. The name with the most documents behind
                             it survives unless --name says otherwise
  zayla unmerge <a>      Take a merge back, restoring both names
  zayla delete <hash>    Remove a document (catalog row + original + derived)
  zayla serve [<port>]   Serve the gallery UI + library data (default port 3000)
  zayla auth-list        Show registered users, passkey counts and who has a password
  zayla auth-password [<username>]
                             Set a user's password (recover a forgotten one).
                             Passkeys, sessions and Me are left as they are
  zayla auth-reset       Remove all users, passkeys & sessions (recover a lost passkey)

A person or organization is named by an id as \`entities\` prints it (#4, or just 4)
or by any spelling the library has seen it under.

The library lives at ./library (override with LIBRARY_DIR).

One process changes the library at a time. While the server runs, the commands
that change it (import, enrich, merge, unmerge, delete, auth-password and
auth-reset) refuse; the ones that only read (show, list, entities, auth-list)
work as usual.

Enrichment sends each document to a Provider: a server speaking the
OpenAI-compatible chat completions API, in the cloud or on this machine. Each
user chooses their own in the web UI, under Settings; \`enrich\` uses the only
user's, and writes titles and summaries in that user's Reading languages. For
one run, without saving:
  --base-url   the endpoint, up to and including /v1
  --model      the model id, as that server names it
  --api-key    sent as a bearer token; the saved key goes only to its own address
Images go as images and PDFs as files; how a server reads a PDF (natively, as
extracted text, or through OCR) is set on that server.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "import": {
      const src = rest[0];
      if (!src) fail(`import needs a file path\n\n${USAGE}`);
      const lib = openToWrite("import");
      try {
        const res = await importFile(lib, src);
        console.log(
          res.deduped
            ? `already imported (deduped)  ${res.hash}`
            : `imported  ${res.hash}`,
        );
        console.log(`  → ${res.path}`);
      } catch (err) {
        fail((err as Error).message);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "enrich": {
      const { hash, cfg } = parseEnrichArgs(rest);
      const lib = openToWrite("enrich");
      try {
        // The CLI runs as nobody in particular, so it reads with the only
        // user's Provider; with several, none of theirs is presumed.
        const users = listUsers(lib);
        let saved: SavedProvider | null = null;
        if (users.length === 1 && users[0])
          saved = savedProvider(lib, users[0].id);
        let provider: ReturnType<typeof getProvider>;
        try {
          provider = getProvider(saved, cfg);
        } catch (err) {
          const hint =
            users.length > 1
              ? "with several users, name one"
              : "choose one in the web UI, under Settings, or name one";
          fail(
            `${(err as Error).message}: ${hint} for this run with --base-url and --model`,
          );
        }
        const targets = hash
          ? [getDocument(lib, hash)].filter((d) => d !== null)
          : listPending(lib);
        if (hash && targets.length === 0)
          fail(`no document with hash: ${hash}`);
        if (targets.length === 0) {
          console.log("(nothing to enrich)");
          break;
        }
        console.log(`using ${provider.model} at ${provider.baseUrl}`);
        const languages = cliReadingLanguages(lib);
        let totalCost = 0;
        let costKnown = false;
        for (const doc of targets) {
          try {
            const out = await enrichDocument(lib, doc, provider, languages);
            const cost =
              out.costUsd !== null ? `  ($${out.costUsd.toFixed(4)})` : "";
            console.log(
              out.status === "deleted"
                ? `deleted    ${doc.hash.slice(0, 12)}  deleted while reading; discarded${cost}`
                : `enriched   ${doc.hash.slice(0, 12)}  ${out.title}${cost}`,
            );
            if (out.costUsd !== null) {
              totalCost += out.costUsd;
              costKnown = true;
            }
          } catch (err) {
            console.error(
              `failed     ${doc.hash.slice(0, 12)}  ${(err as Error).message}`,
            );
          }
        }
        if (costKnown) console.log(`total cost: $${totalCost.toFixed(4)}`);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "show": {
      const ref = rest[0];
      if (!ref) fail(`show needs a hash\n\n${USAGE}`);
      const lib = openToRead();
      try {
        const matches = findDocumentsByPrefix(lib, ref);
        if (matches.length === 0) fail(`no document matching: ${ref}`);
        const languages = cliReadingLanguages(lib);
        if (matches.length > 1) {
          fail(
            `ambiguous prefix '${ref}' matches ${matches.length} documents:\n` +
              matches
                .map(
                  (m) => `  ${m.hash.slice(0, 16)}  ${titleFor(m, languages)}`,
                )
                .join("\n"),
          );
        }
        const match = matches[0];
        if (match) printDocument(match, languages);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "list": {
      const lib = openToRead();
      try {
        const docs = listDocuments(lib);
        if (docs.length === 0) {
          console.log("(no documents)");
          break;
        }
        const languages = cliReadingLanguages(lib);
        for (const d of docs) {
          const label = titleFor(d, languages);
          console.log(
            `${d.hash}  ${d.status.padEnd(10)}  ${d.addedAt}  ${label}`,
          );
        }
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "entities": {
      const lib = openToRead();
      try {
        const listed = listEntities(lib);
        if (listed.length === 0) {
          console.log(
            "(no persons or organizations yet — enrich some documents first)",
          );
          break;
        }
        printEntities(
          "ORGANIZATIONS",
          listed.filter((e) => e.kind === "organization"),
        );
        printEntities(
          "PEOPLE",
          listed.filter((e) => e.kind === "person"),
        );
        printDuplicates(suggestDuplicates(listed));
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "merge": {
      const {
        refs: [refA, refB],
        displayName,
      } = parseMergeArgs(rest);
      if (refA === undefined || refB === undefined)
        fail(`merge needs two persons or organizations\n\n${USAGE}`);
      const lib = openToWrite("merge");
      try {
        const { survivor, absorbed } = mergeEntities(
          lib,
          entityNamed(lib, refA).id,
          entityNamed(lib, refB).id,
          { displayName },
        );
        console.log(
          `merged    ${entityLabel(absorbed)}  into  ${entityLabel(survivor)}`,
        );
        console.log(
          `  → ${survivor.displayName} ${appears(survivor.documents)}`,
        );
      } catch (err) {
        fail((err as Error).message);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "unmerge": {
      const ref = rest[0];
      if (!ref) fail(`unmerge needs a person or organization\n\n${USAGE}`);
      const lib = openToWrite("unmerge");
      try {
        const { survivor, restored } = unmergeEntity(
          lib,
          entityNamed(lib, ref).id,
        );
        console.log(
          `unmerged  ${entityLabel(restored)}  from  ${entityLabel(survivor)}`,
        );
        console.log(
          `  → ${restored.displayName} ${appears(restored.documents)}`,
        );
        console.log(
          `  → ${survivor.displayName} ${appears(survivor.documents)}`,
        );
      } catch (err) {
        fail((err as Error).message);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "delete": {
      const hash = rest[0];
      if (!hash) fail(`delete needs a hash\n\n${USAGE}`);
      const lib = openToWrite("delete");
      try {
        const res = await deleteFile(lib, hash);
        console.log(`deleted   ${res.hash}`);
        console.log(`  → ${res.filename}`);
      } catch (err) {
        fail((err as Error).message);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "serve": {
      const port = Number(rest[0] ?? process.env.PORT ?? 3000);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        fail(`invalid port: ${rest[0]}`);
      const { startServer } = await import("./serve.ts");
      // The server is the Library's writer for as long as it runs.
      const lib = openToWrite(SERVER);
      const server = startServer(port, lib);
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.on(signal, () => {
          server.stop();
          closeLibrary(lib);
          process.exit(0);
        });
      console.log(`serving the library at ${server.url}`);
      console.log("Ctrl-C to stop.");
      break;
    }

    case "auth-list": {
      const lib = openToRead();
      try {
        const users = listUsers(lib);
        if (users.length === 0) {
          console.log(
            "(no users registered — the server prints a Setup code when it starts)",
          );
          break;
        }
        for (const u of users) {
          const creds = listCredentialsForUser(lib, u.id);
          const password = hasPassword(lib, u.id) ? "password" : "no password";
          console.log(
            `${u.username.padEnd(16)}  ${creds.length} passkey${creds.length === 1 ? "" : "s"}  ${password}  (registered ${u.createdAt})`,
          );
        }
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "auth-password": {
      const lib = openToWrite("auth-password");
      try {
        const users = listUsers(lib);
        if (users.length === 0)
          fail("no users registered — there is nobody to give a password to");
        // While the Library has one user, there is no name to give.
        const user = rest[0]
          ? users.find((u) => u.username === rest[0])
          : users.length === 1
            ? users[0]
            : undefined;
        if (!user)
          fail(
            rest[0]
              ? `no user named ${rest[0]}`
              : `name the user: ${users.map((u) => u.username).join(", ")}`,
          );
        const password = readSecret(`New password for ${user.username}:`);
        if (!isAcceptablePassword(password)) fail(PASSWORD_RULE);
        if (readSecret("Again, to confirm:") !== password)
          fail("the passwords don't match");
        await setPassword(lib, user.id, password);
        console.log(`password set for ${user.username}`);
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case "auth-reset": {
      const answer = prompt(
        "Remove ALL users, passkeys, sessions, Providers and who each had marked as me? " +
          "Documents are untouched. Type 'yes' to confirm:",
      );
      if (answer !== "yes") {
        console.log("aborted");
        break;
      }
      const lib = openToWrite("auth-reset");
      try {
        // Each user's Me, Provider and key are in their own file, so they go
        // with the user: the next owner of the Library makes their own.
        clearAllAuth(lib);
        console.log(
          "auth reset — restart the server for a Setup code to create a new owner.",
        );
      } finally {
        closeLibrary(lib);
      }
      break;
    }

    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      break;

    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

/**
 * Print one section of the entity listing: the id `merge` and `unmerge` take,
 * how many documents each entity appears in, the roles it played and, for a
 * person, the organizations they appeared for. Names merged into an entity are
 * named too, so the merge to take back can be seen. Ids and names are padded to
 * the widest in the section so the counts and roles line up.
 */
function printEntities(heading: string, entities: EntityListing[]): void {
  console.log(`\n${heading}`);
  if (entities.length === 0) {
    console.log("  (none)");
    return;
  }
  const ids = Math.max(...entities.map((e) => String(e.id).length));
  const width = Math.max(...entities.map((e) => e.displayName.length));
  for (const e of entities) {
    const count = String(e.documents).padStart(4);
    const id = `#${e.id}`.padEnd(ids + 1);
    const roles = e.roles.join(", ");
    const affiliations = e.affiliations.length
      ? `  (for ${e.affiliations.map((a) => a.displayName).join(", ")})`
      : "";
    const merged = e.mergedNames.length
      ? `  (merged ${e.mergedNames.map(entityLabel).join(", ")})`
      : "";
    console.log(
      `${count}  ${id}  ${e.displayName.padEnd(width)}  ${roles}${affiliations}${merged}`,
    );
  }
}

/**
 * The one person or organization a reference names. A spelling two kinds of name
 * answer to, or an id that is nobody's, is reported rather than guessed at.
 */
function entityNamed(lib: Library, ref: string): EntityRef {
  const matches = findEntities(lib, ref);
  const only = matches[0];
  if (!only) fail(`no person or organization matching: ${ref}`);
  if (matches.length > 1)
    fail(
      `'${ref}' names ${matches.length} of them — say which by its id:\n` +
        matches
          .map((m) => `  #${m.id}  ${m.kind.padEnd(12)}  ${m.displayName}`)
          .join("\n"),
    );
  return only;
}

/** A person or organization as the merge commands report it. */
const entityLabel = (e: NamedEntity) => `#${e.id} ${e.displayName}`;

/** "appears in 22 documents", counted once per document. */
const appears = (documents: number) =>
  `appears in ${documents} document${documents === 1 ? "" : "s"}`;

/** Parse `merge` args: two positional references plus an optional --name. */
function parseMergeArgs(args: string[]): {
  refs: string[];
  displayName?: string;
} {
  const refs: string[] = [];
  let displayName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--name") displayName = args[++i];
    else if (a.startsWith("--name=")) displayName = a.slice("--name=".length);
    else if (!a.startsWith("--")) refs.push(a);
  }
  return { refs, displayName };
}

/**
 * Print the pairs of names that look like they belong to one person or
 * organization, with each one's document count so the owner can see which
 * spelling the library leans on. The closing note is not decoration: a heading
 * reading "suspected duplicates" with nothing said about it invites the reader
 * to assume something was done about them, and nothing was. It now also names
 * the command that answers one, which is the whole point of pointing them out.
 */
function printDuplicates(suggestions: DuplicateSuggestion[]): void {
  console.log("\nSUSPECTED DUPLICATES");
  if (suggestions.length === 0) {
    console.log("  (none)");
    return;
  }
  const label = (e: EntityListing) => `${e.displayName} (${e.documents})`;
  const width = Math.max(
    ...suggestions.map(({ entities }) => label(entities[0]).length),
  );
  for (const { kind, entities } of suggestions)
    console.log(
      `  ${kind.padEnd(12)}  ${label(entities[0]).padEnd(width)}  ↔  ${label(entities[1])}`,
    );
  console.log("\n  Nothing has been merged: these are questions, not changes.");
  console.log("  Answer one with: zayla merge <a> <b>");
}

/**
 * The Reading languages the CLI reads and shows in. It runs as nobody in
 * particular, so like the Provider it takes the only user's; with none, or
 * several, none of theirs is presumed and it reads in the default.
 */
function cliReadingLanguages(lib: Library): string[] {
  const users = listUsers(lib);
  return users.length === 1 && users[0]
    ? readingLanguagesOf(lib, users[0].id)
    : [...DEFAULT_READING_LANGUAGES];
}

/** What a Document is called, in these Reading languages: its filename until it has a title. */
const titleFor = (d: DocumentRecord, languages: string[]): string =>
  shownText(d, languages)?.title ?? d.filename;

/** Pretty-print a document's full record: catalog fields, then enrichment (if any). */
function printDocument(d: DocumentRecord, languages: string[]): void {
  const row = (k: string, v: string) => console.log(`  ${k.padEnd(11)}${v}`);
  const list = (a: string[] | null) => (a?.length ? a.join(", ") : "—");

  console.log(titleFor(d, languages));
  row("hash", d.hash);
  row("file", `${d.filename}  (${d.mime}, ${d.bytes.toLocaleString()} bytes)`);
  row("status", d.status);
  row("added", d.addedAt);

  if (d.status === "enriched") {
    console.log();
    row("date", d.docDate ?? "—");
    row("languages", list(d.languages));
    row("people", list(d.people));
    row("keywords", list(d.keywords));
    row("summary", shownText(d, languages)?.summary || "—");
    row("written in", list(Object.keys(d.texts)));
    if (d.ref?.length) {
      console.log("  key facts");
      for (const { key, value } of d.ref) console.log(`    ${key}: ${value}`);
    }
    console.log();
    row(
      "via",
      `${d.enrichModel ?? "?"} at ${d.enrichBaseUrl ?? d.enrichProvider ?? "?"}  (text: ${d.textSource ?? "?"}, at ${d.enrichedAt ?? "?"})`,
    );
  } else if (d.status === "needs_ocr") {
    console.log(
      `\n  (flagged for a vision pass before the pipeline went vision-only — re-run: zayla enrich ${d.hash.slice(0, 12)})`,
    );
  } else {
    console.log(
      `\n  (not enriched yet — run: zayla enrich ${d.hash.slice(0, 12)})`,
    );
  }
}

/** Parse `enrich` args: one optional positional hash plus --base-url/--model/--api-key flags. */
function parseEnrichArgs(args: string[]): {
  hash?: string;
  cfg: ProviderConfig;
} {
  const cfg: ProviderConfig = {};
  let hash: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--base-url") cfg.baseUrl = args[++i];
    else if (a.startsWith("--base-url="))
      cfg.baseUrl = a.slice("--base-url=".length);
    else if (a === "--model") cfg.model = args[++i];
    else if (a.startsWith("--model=")) cfg.model = a.slice("--model=".length);
    else if (a === "--api-key") cfg.apiKey = args[++i];
    else if (a.startsWith("--api-key="))
      cfg.apiKey = a.slice("--api-key=".length);
    else if (!a.startsWith("--") && hash === undefined) hash = a;
  }
  return { hash, cfg };
}

/**
 * Ask for a secret on the terminal without echoing it. Piped input (no TTY)
 * is read as given, so `echo … | zayla auth-password` works too.
 */
function readSecret(question: string): string | null {
  const tty = process.stdin.isTTY;
  const stty = (arg: string) =>
    Bun.spawnSync(["stty", arg], { stdin: "inherit" });
  if (tty) stty("-echo");
  try {
    return prompt(question);
  } finally {
    if (tty) {
      stty("echo");
      process.stdout.write("\n");
    }
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * Open the Library to read it. Reading needs no lock, so this works while the
 * server runs.
 */
function openToRead(): Library {
  return openLibrary(libraryRoot());
}

/**
 * Open the Library to change it, as its one writer: refused while the server,
 * or another command that changes it, is running.
 */
function openToWrite(command: string): Library {
  try {
    return openLibrary(libraryRoot(), { writer: command });
  } catch (err) {
    if (err instanceof LibraryLocked) fail(lockedMessage(err.holder));
    throw err;
  }
}

/** Why a command that changes the Library may not run while `holder` holds it. */
function lockedMessage(holder: LockHolder): string {
  return holder.by === SERVER
    ? `the Zayla server (process ${holder.pid}) is using this library. Stop the server, or make this change in the web interface.`
    : `zayla ${holder.by} (process ${holder.pid}) is changing this library. Wait for it to finish, then try again.`;
}

main();
