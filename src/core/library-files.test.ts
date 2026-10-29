import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { parse } from "yaml";
import {
  createSession,
  createUser,
  deleteSession,
  getSessionUserId,
  insertCredential,
  listCredentialsForUser,
  listUsers,
  setPassword,
  storePasswordHash,
  userWithPassword,
  verifyPassword,
} from "./auth.ts";
import {
  type CatalogFields,
  closeLibrary,
  deleteDocument,
  insertDocument,
  type Library,
  openLibrary,
  updateEnrichment,
} from "./db.ts";
import type { EnrichedMetadata } from "./enrich.ts";
import { keyFor, savedProvider, saveProvider } from "./enrich.ts";
import {
  entityDetail,
  findEntities,
  listEntities,
  markedAsMe,
  markMe,
  mergeEntities,
  unmergeEntity,
} from "./entities.ts";
import {
  readingLanguagesOf,
  setReadingLanguages,
} from "./reading-languages.ts";

/**
 * Users and naming are held in readable files under the Library root, and
 * read back whenever the Library is opened; the Appearances are worked out
 * again from each Document's Enrichment.
 */

const TMP = `/tmp/dm-library-files-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const EMPTY: EnrichedMetadata = {
  texts: {},
  people: [],
  sender: { organization: "", person: "" },
  receiver: { organization: "", person: "" },
  deadlines: [],
  date: null,
  languages: [],
  keywords: [],
  ref: [],
};

const catalog = (hash: string): CatalogFields => ({
  hash,
  ext: "pdf",
  mime: "application/pdf",
  filename: `${hash.slice(0, 6)}.pdf`,
  bytes: 1,
  status: "imported",
  addedAt: "2026-01-02T03:04:05.000Z",
});

/** File a Document and Enrich it with a reading that names these parties. */
function read(
  lib: Library,
  hash: string,
  parties: Partial<Pick<EnrichedMetadata, "sender" | "receiver" | "people">>,
): void {
  insertDocument(lib, catalog(hash));
  updateEnrichment(
    lib,
    hash,
    { ...EMPTY, ...parties },
    { textSource: "vision", baseUrl: "http://mock.test/v1", model: "mock" },
  );
}

function reopen(lib: Library): Library {
  closeLibrary(lib);
  return openLibrary(TMP, { writer: "test" });
}

const idOf = (lib: Library, name: string): number => {
  const found = listEntities(lib).find((e) => e.displayName === name);
  if (!found) throw new Error(`no entity displayed as ${name}`);
  return found.id;
};

test("users come back from their files with everything they had", async () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jordan Okafor"] });
    const owner = createUser(lib, "owner", "The Owner");
    await setPassword(lib, owner.id, "correct horse battery");
    insertCredential(lib, {
      id: "passkey-1",
      userId: owner.id,
      publicKey: new Uint8Array([1, 2, 3, 250]),
      counter: 7,
      transports: ["internal", "hybrid"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    const token = createSession(lib, owner.id);
    saveProvider(lib, owner.id, {
      baseUrl: "https://example.test/v1",
      model: "qwen/x",
      apiKey: "sk-test",
    });
    setReadingLanguages(lib, owner.id, ["DE", "EN"]);
    const jordan = idOf(lib, "Jordan Okafor");
    markMe(lib, owner.id, jordan);
    const provider = savedProvider(lib, owner.id);
    const passkeys = listCredentialsForUser(lib, owner.id);

    lib = reopen(lib);

    expect(listUsers(lib)).toEqual([owner]);
    expect(await verifyPassword(lib, owner.id, "correct horse battery")).toBe(
      true,
    );
    expect((await userWithPassword(lib, "correct horse battery"))?.id).toBe(
      owner.id,
    );
    expect(listCredentialsForUser(lib, owner.id)).toEqual(passkeys);
    expect(passkeys[0]?.publicKey).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(getSessionUserId(lib, token)).toBe(owner.id);
    expect(savedProvider(lib, owner.id)).toEqual(provider);
    expect(readingLanguagesOf(lib, owner.id)).toEqual(["DE", "EN"]);
    expect(markedAsMe(lib, owner.id)).toBe(jordan);
  } finally {
    closeLibrary(lib);
  }
});

test("People, Organizations, Merges and counts read the same after reopening", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), {
      sender: { organization: "Acme Foundation", person: "Jane Doe" },
    });
    read(lib, "b".repeat(64), {
      sender: { organization: "Acme Stiftung", person: "J. Doe" },
      people: ["Jordan Okafor"],
    });
    read(lib, "c".repeat(64), { people: ["Jane Doe", "Jordan Okafor"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane A. Doe",
    });
    mergeEntities(
      lib,
      idOf(lib, "Acme Foundation"),
      idOf(lib, "Acme Stiftung"),
    );
    const listed = listEntities(lib);
    const pages = listed.map((e) => entityDetail(lib, e.id));

    lib = reopen(lib);

    expect(listEntities(lib)).toEqual(listed);
    expect(listed.map((e) => entityDetail(lib, e.id))).toEqual(pages);

    // A Merge taken back after reopening is as exact as one taken back before.
    unmergeEntity(lib, findEntities(lib, "J. Doe")[0]?.id ?? 0);
    expect(
      listEntities(lib)
        .filter((e) => e.kind === "person")
        .map((e) => [e.displayName, e.documents]),
    ).toEqual([
      ["Jane Doe", 2],
      ["Jordan Okafor", 2],
      ["J. Doe", 1],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a merged page lists each name's first spelling, then those a Merge taught", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe"] });
    read(lib, "b".repeat(64), { people: ["J. Doe"] });
    read(lib, "c".repeat(64), { people: ["Janie Doe"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane A. Doe",
    });
    mergeEntities(lib, idOf(lib, "Jane A. Doe"), idOf(lib, "Janie Doe"));
    const expected = ["Jane Doe", "J. Doe", "Janie Doe", "Jane A. Doe"];
    expect(entityDetail(lib, idOf(lib, "Jane A. Doe"))?.variants).toEqual(
      expected,
    );

    lib = reopen(lib);

    expect(entityDetail(lib, idOf(lib, "Jane A. Doe"))?.variants).toEqual(
      expected,
    );
  } finally {
    closeLibrary(lib);
  }
});

test("entity ids stay the same integers across reopening", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe", "Jordan Okafor"] });
    const ids = listEntities(lib).map((e) => [e.displayName, e.id]);

    lib = reopen(lib);
    read(lib, "b".repeat(64), { people: ["Jana Okafor"] });

    expect(
      listEntities(lib)
        .filter((e) => e.displayName !== "Jana Okafor")
        .map((e) => [e.displayName, e.id]),
    ).toEqual(ids);
    // A new name takes an id nobody has had.
    expect(idOf(lib, "Jana Okafor")).toBeGreaterThan(
      Math.max(...ids.map(([, id]) => id as number)),
    );
  } finally {
    closeLibrary(lib);
  }
});

test("a Person keeps their Name variants after their last Document is Deleted", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe"] });
    read(lib, "b".repeat(64), { people: ["J. Doe"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));
    const jane = idOf(lib, "Jane Doe");
    deleteDocument(lib, "a".repeat(64));
    deleteDocument(lib, "b".repeat(64));

    lib = reopen(lib);
    expect(listEntities(lib)).toEqual([]);
    read(lib, "c".repeat(64), { people: ["J. Doe"] });

    expect(listEntities(lib).map((e) => [e.id, e.displayName])).toEqual([
      [jane, "Jane Doe"],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("naming.yaml is YAML a person can read", () => {
  const lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), {
      sender: { organization: "Acme Foundation", person: "Jane Doe" },
    });
    read(lib, "b".repeat(64), { people: ["J. Doe"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane A. Doe",
    });
  } finally {
    closeLibrary(lib);
  }

  const naming = parse(readFileSync(`${TMP}/naming.yaml`, "utf8"));
  expect(naming.next_id).toBe(4);
  expect(naming.people).toEqual([
    { id: 2, name: "Jane A. Doe", variants: ["Jane Doe", "Jane A. Doe"] },
    { id: 3, name: "J. Doe", variants: ["J. Doe"] },
  ]);
  expect(naming.organizations).toEqual([
    { id: 1, name: "Acme Foundation", variants: ["Acme Foundation"] },
  ]);
  expect(naming.merges).toEqual([
    {
      absorbed: 3,
      survivor: 2,
      chosen_name: "Jane A. Doe",
      replaced_name: "Jane Doe",
      adopted_name: "Jane A. Doe",
    },
  ]);
});

test("a user's file is YAML a person can read, with only a hash of the password", async () => {
  const lib = openLibrary(TMP, { writer: "test" });
  let id = "";
  try {
    const owner = createUser(lib, "owner", "The Owner");
    id = owner.id;
    await setPassword(lib, owner.id, "correct horse battery");
    createSession(lib, owner.id);
    saveProvider(lib, owner.id, {
      baseUrl: "https://example.test/v1",
      model: "qwen/x",
      apiKey: "sk-test",
    });
  } finally {
    closeLibrary(lib);
  }

  const text = readFileSync(`${TMP}/users/${id}.yaml`, "utf8");
  expect(text).not.toContain("correct horse battery");
  const user = parse(text);
  expect(user.username).toBe("owner");
  expect(user.display_name).toBe("The Owner");
  expect(user.password_hash).toStartWith("$argon2id$");
  expect(user.reading_languages).toEqual(["EN"]);
  expect(user.provider).toMatchObject({
    base_url: "https://example.test/v1",
    model: "qwen/x",
    api_key: "sk-test",
  });
  expect(user.sessions).toHaveLength(1);
  expect(user.sessions[0]).toHaveProperty("expires_at");
});

test("a Provider saved before OpenRouter was its own kind reads as OpenRouter with Zero retention at its address, and as Custom elsewhere", async () => {
  let lib = openLibrary(TMP, { writer: "test" });
  const ada = createUser(lib, "ada", null);
  const ben = createUser(lib, "ben", null);
  closeLibrary(lib);
  const older = (baseUrl: string) =>
    `username: x\ncreated_at: "2026-01-02T03:04:05.000Z"\nprovider:\n  base_url: ${baseUrl}\n  model: qwen/x\n  api_key: sk-test\n  chosen_at: "2026-01-02T03:04:05.000Z"\n`;
  await Bun.write(
    `${TMP}/users/${ada.id}.yaml`,
    older("https://openrouter.ai/api/v1"),
  );
  await Bun.write(
    `${TMP}/users/${ben.id}.yaml`,
    older("http://127.0.0.1:8001/v1"),
  );

  lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(savedProvider(lib, ada.id)).toMatchObject({
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "qwen/x",
      apiKey: "sk-test",
      zeroRetention: true,
    });
    expect(savedProvider(lib, ben.id)).toMatchObject({
      kind: "custom",
      baseUrl: "http://127.0.0.1:8001/v1",
      zeroRetention: false,
    });
  } finally {
    closeLibrary(lib);
  }
});

test("an older Provider at OpenRouter under another spelling keeps its key for OpenRouter's address", async () => {
  let lib = openLibrary(TMP, { writer: "test" });
  const owner = createUser(lib, "owner", null);
  closeLibrary(lib);
  await Bun.write(
    `${TMP}/users/${owner.id}.yaml`,
    `username: owner\ncreated_at: "2026-01-02T03:04:05.000Z"\nprovider:\n  base_url: https://www.OpenRouter.ai/api/v1/\n  model: qwen/x\n  api_key: sk-test\n  chosen_at: "2026-01-02T03:04:05.000Z"\n`,
  );

  lib = openLibrary(TMP, { writer: "test" });
  try {
    expect(savedProvider(lib, owner.id)).toMatchObject({
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(keyFor(lib, owner.id, "https://openrouter.ai/api/v1")).toBe(
      "sk-test",
    );
  } finally {
    closeLibrary(lib);
  }
});

test("Zero retention turned off stays off after reopening", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    const owner = createUser(lib, "owner", null);
    saveProvider(lib, owner.id, {
      kind: "openrouter",
      model: "qwen/x",
      zeroRetention: false,
    });

    lib = reopen(lib);

    expect(savedProvider(lib, owner.id)).toMatchObject({
      kind: "openrouter",
      zeroRetention: false,
    });
  } finally {
    closeLibrary(lib);
  }
});

test("nothing creates library.db", async () => {
  const lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe"] });
    const owner = createUser(lib, "owner", null);
    createSession(lib, owner.id);
  } finally {
    closeLibrary(lib);
  }
  expect(readdirSync(TMP).filter((f) => f.startsWith("library.db"))).toEqual(
    [],
  );
});

test("a spelling first seen when the Library opens is learned, and only the writer writes it", async () => {
  const writer = openLibrary(TMP, { writer: "test" });
  try {
    read(writer, "a".repeat(64), { people: ["Jane Doe"] });
  } finally {
    closeLibrary(writer);
  }
  // As if the rules for reading parties had changed since: the naming has
  // never heard of the name this Document's Enrichment gives.
  await rm(`${TMP}/naming.yaml`);

  const reader = openLibrary(TMP);
  try {
    expect(listEntities(reader).map((e) => e.displayName)).toEqual([
      "Jane Doe",
    ]);
  } finally {
    closeLibrary(reader);
  }
  expect(readdirSync(TMP)).not.toContain("naming.yaml");

  closeLibrary(openLibrary(TMP, { writer: "test" }));
  const naming = parse(readFileSync(`${TMP}/naming.yaml`, "utf8"));
  expect(naming.people).toEqual([
    { id: 1, name: "Jane Doe", variants: ["Jane Doe"] },
  ]);
});

/** Run `fn` with the directory at `dir` closed to writing. */
function readOnly(dir: string, fn: () => void): void {
  chmodSync(dir, 0o500);
  try {
    fn();
  } finally {
    chmodSync(dir, 0o700);
  }
}

test("a change to a user whose file can't be written leaves the user as they were", async () => {
  const lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jordan Okafor"] });
    const owner = createUser(lib, "owner", null);
    await setPassword(lib, owner.id, "correct horse battery");
    const token = createSession(lib, owner.id);
    const jordan = idOf(lib, "Jordan Okafor");
    const before = structuredClone(lib.users.get(owner.id));

    readOnly(`${TMP}/users`, () => {
      expect(() => markMe(lib, owner.id, jordan)).toThrow();
      expect(() => setReadingLanguages(lib, owner.id, ["DE"])).toThrow();
      expect(() =>
        saveProvider(lib, owner.id, {
          baseUrl: "https://example.test/v1",
          model: "qwen/x",
          apiKey: "sk-test",
        }),
      ).toThrow();
      expect(() => storePasswordHash(lib, owner.id, "not-a-hash")).toThrow();
      expect(() => createSession(lib, owner.id)).toThrow();
      expect(() => deleteSession(lib, token)).toThrow();
      expect(() =>
        insertCredential(lib, {
          id: "passkey-1",
          userId: owner.id,
          publicKey: new Uint8Array([1]),
          counter: 0,
          transports: undefined,
          deviceType: "singleDevice",
          backedUp: false,
        }),
      ).toThrow();
      expect(() => createUser(lib, "second", null)).toThrow();
    });

    expect(lib.users.get(owner.id)).toEqual(before);
    expect(listUsers(lib)).toEqual([owner]);
    expect(markedAsMe(lib, owner.id)).toBeNull();
    expect(await verifyPassword(lib, owner.id, "correct horse battery")).toBe(
      true,
    );
    expect(getSessionUserId(lib, token)).toBe(owner.id);
  } finally {
    closeLibrary(lib);
  }
});

test("taking back a Merge that taught a spelling reads the same before and after reopening", () => {
  let lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe"] });
    read(lib, "b".repeat(64), { people: ["J. Doe"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane A. Doe",
    });
    // Read while the Merge stood: the spelling it taught resolves to the
    // surviving name.
    read(lib, "c".repeat(64), { people: ["Jane A. Doe"] });
    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane A. Doe", 3],
    ]);

    unmergeEntity(lib, findEntities(lib, "J. Doe")[0]?.id ?? 0);
    const listed = listEntities(lib);
    const pages = listed.map((e) => entityDetail(lib, e.id));
    expect(listed.map((e) => [e.displayName, e.documents])).toEqual([
      ["J. Doe", 1],
      ["Jane A. Doe", 1],
      ["Jane Doe", 1],
    ]);

    lib = reopen(lib);

    expect(listEntities(lib)).toEqual(listed);
    expect(listed.map((e) => entityDetail(lib, e.id))).toEqual(pages);
  } finally {
    closeLibrary(lib);
  }
});

test("a Merge or an unmerge whose naming.yaml can't be written leaves the naming as it was", () => {
  const lib = openLibrary(TMP, { writer: "test" });
  try {
    read(lib, "a".repeat(64), { people: ["Jane Doe"] });
    read(lib, "b".repeat(64), { people: ["J. Doe"] });
    read(lib, "c".repeat(64), { people: ["Janie Doe"] });
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "Janie Doe"), {
      displayName: "Jane A. Doe",
    });
    const listed = listEntities(lib);
    const pages = listed.map((e) => entityDetail(lib, e.id));
    const janie = findEntities(lib, "Janie Doe")[0]?.id ?? 0;
    const jDoe = idOf(lib, "J. Doe");

    readOnly(TMP, () => {
      expect(() =>
        mergeEntities(lib, idOf(lib, "Jane A. Doe"), jDoe, {
          displayName: "Jane B. Doe",
        }),
      ).toThrow();
      expect(() => unmergeEntity(lib, janie)).toThrow();
    });

    expect(listEntities(lib)).toEqual(listed);
    expect(listed.map((e) => entityDetail(lib, e.id))).toEqual(pages);
    expect(findEntities(lib, "Jane B. Doe")).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("a document.yaml that can't be read leaves that Document out, with a warning naming it, and the rest open", async () => {
  let lib = openLibrary(TMP, { writer: "test" });
  read(lib, "a".repeat(64), { people: ["Jordan Okafor"] });
  read(lib, "b".repeat(64), { people: ["Jordan Okafor"] });
  closeLibrary(lib);
  const broken = `${TMP}/about/${"b".repeat(64)}/document.yaml`;
  await Bun.write(broken, "");

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    lib = openLibrary(TMP, { writer: "test" });
    expect([...lib.documents.keys()]).toEqual(["a".repeat(64)]);
    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jordan Okafor", 1],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(broken);
  } finally {
    warn.mockRestore();
    closeLibrary(lib);
  }
});

test("a naming.yaml that can't be read stops the Library opening, naming the file", async () => {
  closeLibrary(openLibrary(TMP, { writer: "test" }));
  await Bun.write(`${TMP}/naming.yaml`, "people: [unclosed\n");

  expect(() => openLibrary(TMP, { writer: "test" })).toThrow(
    `${TMP}/naming.yaml`,
  );
  // Refused rather than overwritten, and the lock let go of.
  expect(readFileSync(`${TMP}/naming.yaml`, "utf8")).toBe(
    "people: [unclosed\n",
  );
  await Bun.write(`${TMP}/naming.yaml`, "next_id: 1\n");
  closeLibrary(openLibrary(TMP, { writer: "test" }));
});

test("a user's file that can't be read stops the Library opening, naming the file", async () => {
  const lib = openLibrary(TMP, { writer: "test" });
  const owner = createUser(lib, "owner", null);
  closeLibrary(lib);
  const path = `${TMP}/users/${owner.id}.yaml`;
  await Bun.write(path, "");

  expect(() => openLibrary(TMP, { writer: "test" })).toThrow(path);
});
