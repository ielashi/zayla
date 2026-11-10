/**
 * A harness for testing Zayla from outside: a test writes the Library it needs
 * as files, in the shapes ADR 0003 describes, starts the server over that
 * folder, and talks to it over HTTP alone. Nothing here calls into Zayla's own
 * code, so the same tests can check any server that keeps a Library the same
 * way and is started the same way: `SERVER_COMMAND` followed by a port (0 for
 * one the system picks), with the Library's folder in `LIBRARY_DIR`, printing
 * the address it serves at as the first URL on its standard output, and
 * stopping on SIGTERM.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { stringify } from "yaml";

/** How to start a server for the Library at `LIBRARY_DIR`, on the port given last. */
const SERVER_COMMAND = [
  "bun",
  // The tests name everything the server reads; a developer's .env mustn't.
  "--no-env-file",
  join(import.meta.dir, "..", "src", "cli.ts"),
  "serve",
];

/** A server a test started, at `url` (no trailing slash), until it is stopped. */
export type RunningZayla = { url: string; stop: () => Promise<void> };

/** A new, empty Library folder. */
export function newLibrary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zayla-library-"));
}

/**
 * Start the server over the Library at `library` on a port the system picks,
 * once it says where it is listening.
 */
export async function startZayla(library: string): Promise<RunningZayla> {
  const proc = Bun.spawn([...SERVER_COMMAND, "0"], {
    env: { PATH: process.env.PATH, LIBRARY_DIR: library },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = async () => {
    proc.kill("SIGTERM");
    // One that won't stop isn't left holding the test until it times out.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    await proc.exited;
    clearTimeout(timer);
  };
  try {
    return { url: await listeningAt(proc.stdout), stop };
  } catch (err) {
    proc.kill("SIGKILL");
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${(err as Error).message}\n${stderr}`);
  }
}

/**
 * The address the server says it serves at, read from its output. What it
 * prints after is read and dropped, so the pipe never fills or closes on it.
 */
async function listeningAt(
  output: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done)
      throw new Error(
        `the server stopped before it said where it listens:\n${seen}`,
      );
    seen += decoder.decode(value, { stream: true });
    const url = seen.match(/https?:\/\/\S+/)?.[0];
    if (url) {
      void drain(reader);
      return url.replace(/\/$/, "");
    }
  }
}

async function drain(reader: { read(): Promise<{ done: boolean }> }) {
  while (!(await reader.read()).done) {}
}

/**
 * Sign in to `zayla` with a password over HTTP. Returns the `Cookie` header
 * that carries the session.
 */
export async function signIn(
  zayla: RunningZayla,
  password: string,
): Promise<string> {
  const res = await fetch(`${zayla.url}/api/auth/password/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const session = res.headers.get("Set-Cookie")?.split(";")[0];
  if (!res.ok || !session)
    throw new Error(`signing in was refused: ${res.status}`);
  return session;
}

/** A Document as a test describes it; anything left out is as an unread Import leaves it. */
export type DocumentSeed = {
  filename: string;
  /** The Original's bytes. */
  content: string | Uint8Array;
  /** Its title in English, as an Enrichment would write it. */
  title?: string;
  /** The people its Enrichment names, which is what makes a Person appear. */
  people?: string[];
  transcription?: string;
};

/**
 * Write a Document: its Original under `objects/`, then its `document.yaml`
 * (and Transcription, if any) under `about/<hash>/`. Returns its hash.
 */
export async function writeDocument(
  library: string,
  doc: DocumentSeed,
): Promise<string> {
  const bytes =
    typeof doc.content === "string"
      ? new TextEncoder().encode(doc.content)
      : doc.content;
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const ext = extname(doc.filename).slice(1).toLowerCase();
  await Bun.write(
    join(library, "objects", ext ? `${hash}.${ext}` : hash),
    bytes,
  );
  const about = join(library, "about", hash);
  if (doc.transcription !== undefined)
    await Bun.write(join(about, "transcription.txt"), doc.transcription);
  const enriched = doc.title !== undefined;
  await Bun.write(
    join(about, "document.yaml"),
    stringify({
      filename: doc.filename,
      ext,
      mime: Bun.file(doc.filename).type.split(";")[0],
      bytes: bytes.length,
      status: enriched ? "enriched" : "imported",
      added_at: new Date().toISOString(),
      ...(enriched
        ? {
            texts: { en: { title: doc.title, summary: "" } },
            languages: ["en"],
          }
        : {}),
      ...(doc.people ? { people: doc.people } : {}),
    }),
  );
  return hash;
}

/** A Person or Organization: its id, the name it is shown under, and its spellings. */
export type EntitySeed = { id: number; name: string; variants?: string[] };

/** Write the Library's `naming.yaml`. */
export async function writeNaming(
  library: string,
  naming: {
    people?: EntitySeed[];
    organizations?: EntitySeed[];
  },
): Promise<void> {
  const entity = (e: EntitySeed) => ({
    id: e.id,
    name: e.name,
    variants: e.variants ?? [e.name],
  });
  const people = (naming.people ?? []).map(entity);
  const organizations = (naming.organizations ?? []).map(entity);
  await Bun.write(
    join(library, "naming.yaml"),
    stringify({
      next_id:
        Math.max(0, ...[...people, ...organizations].map((e) => e.id)) + 1,
      people,
      organizations,
      merges: [],
    }),
  );
}

/** Write a user who signs in with `password`, under `users/<id>.yaml`. Returns their id. */
export async function writeUser(
  library: string,
  user: { username: string; password: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await Bun.write(
    join(library, "users", `${id}.yaml`),
    stringify({
      username: user.username,
      created_at: new Date().toISOString(),
      password_hash: await Bun.password.hash(user.password, {
        algorithm: "argon2id",
      }),
    }),
  );
  return id;
}
