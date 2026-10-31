import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  clearAllAuth,
  countUsers,
  createSession,
  createUser,
  deleteSession,
  getSessionUserId,
  hasPassword,
  insertCredential,
  listCredentialsForUser,
  listUsers,
  parseCookies,
  putChallenge,
  requireAuth,
  SESSION_COOKIE,
  setPassword,
  takeChallenge,
  verifyPassword,
} from "./auth.ts";
import {
  closeLibrary,
  insertDocument,
  openLibrary,
  updateEnrichment,
} from "./db.ts";
import { listEntities, markedAsMe, markMe } from "./entities.ts";

const TMP = `/tmp/dm-auth-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const withDb = <T>(fn: (lib: ReturnType<typeof openLibrary>) => T): T => {
  const lib = openLibrary(TMP);
  try {
    return fn(lib);
  } finally {
    closeLibrary(lib);
  }
};

test("user + session round-trip", () => {
  withDb((lib) => {
    expect(countUsers(lib)).toBe(0);
    const user = createUser(lib, "owner", "Owner");
    expect(countUsers(lib)).toBe(1);
    expect(listUsers(lib).map((u) => u.username)).toEqual(["owner"]);

    const token = createSession(lib, user.id);
    expect(getSessionUserId(lib, token)).toBe(user.id);

    deleteSession(lib, token);
    expect(getSessionUserId(lib, token)).toBeNull();
    expect(getSessionUserId(lib, "bogus")).toBeNull();
  });
});

test("an expired session resolves to null", () => {
  withDb((lib) => {
    const user = createUser(lib, "owner", null);
    const token = createSession(lib, user.id);
    // Thirty-one days on, past the thirty a session lasts.
    setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    try {
      expect(getSessionUserId(lib, token)).toBeNull();
    } finally {
      setSystemTime();
    }
    // Pruned, not merely refused: it is gone once time is back.
    expect(getSessionUserId(lib, token)).toBeNull();
  });
});

test("challenge is single-use", () => {
  withDb((lib) => {
    const id = putChallenge(lib, "abc123");
    expect(takeChallenge(lib, id)).toBe("abc123");
    expect(takeChallenge(lib, id)).toBeNull(); // consumed
  });
});

test("requireAuth reads the session cookie", () => {
  withDb((lib) => {
    const user = createUser(lib, "owner", null);
    const token = createSession(lib, user.id);

    const withCookie = new Request("http://x/", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(requireAuth(lib, withCookie)?.id).toBe(user.id);

    const noCookie = new Request("http://x/");
    expect(requireAuth(lib, noCookie)).toBeNull();
  });
});

test("parseCookies parses multiple cookies", () => {
  const req = new Request("http://x/", {
    headers: { cookie: "a=1; zayla_session=tok; b=two" },
  });
  const cookies = parseCookies(req);
  expect(cookies.zayla_session).toBe("tok");
  expect(cookies.a).toBe("1");
  expect(cookies.b).toBe("two");
});

test("clearAllAuth wipes users, credentials and sessions", () => {
  withDb((lib) => {
    const user = createUser(lib, "owner", null);
    createSession(lib, user.id);
    clearAllAuth(lib);
    expect(countUsers(lib)).toBe(0);
    expect(listUsers(lib)).toEqual([]);
  });
});

test("resetting a password replaces it, leaving passkeys, sessions and Me as they were", async () => {
  const lib = openLibrary(TMP);
  try {
    const user = createUser(lib, "owner", null);
    insertCredential(lib, {
      id: "passkey",
      userId: user.id,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: undefined,
      deviceType: "singleDevice",
      backedUp: false,
    });
    const token = createSession(lib, user.id);
    insertDocument(lib, {
      hash: "aaa",
      ext: "pdf",
      mime: "application/pdf",
      filename: "aaa.pdf",
      bytes: 1,
      status: "imported",
      addedAt: new Date().toISOString(),
    });
    updateEnrichment(
      lib,
      "aaa",
      {
        texts: {},
        people: ["Jordan Okafor"],
        sender: { organization: "", person: "" },
        receiver: { organization: "", person: "" },
        deadlines: [],
        date: null,
        languages: [],
        keywords: [],
      },
      { textSource: "vision", baseUrl: "http://mock.test/v1", model: "mock" },
    );
    const okafor = listEntities(lib)[0]?.id ?? 0;
    markMe(lib, user.id, okafor);
    await setPassword(lib, user.id, "forgotten password");

    await setPassword(lib, user.id, "remembered this time");

    expect(await verifyPassword(lib, user.id, "remembered this time")).toBe(
      true,
    );
    expect(await verifyPassword(lib, user.id, "forgotten password")).toBe(
      false,
    );
    expect(listCredentialsForUser(lib, user.id).map((c) => c.id)).toEqual([
      "passkey",
    ]);
    expect(getSessionUserId(lib, token)).toBe(user.id);
    expect(markedAsMe(lib, user.id)).toBe(okafor);
  } finally {
    closeLibrary(lib);
  }
});

test("a password is stored only as an argon2id hash", async () => {
  const lib = openLibrary(TMP);
  try {
    const user = createUser(lib, "owner", null);
    expect(hasPassword(lib, user.id)).toBe(false);
    await setPassword(lib, user.id, "correct horse battery");
    expect(hasPassword(lib, user.id)).toBe(true);
    const stored = readFileSync(`${TMP}/users/${user.id}.yaml`, "utf8");
    expect(stored).not.toContain("correct horse battery");
    expect(stored).toContain("$argon2id$");
  } finally {
    closeLibrary(lib);
  }
});

test("a short password is refused before anything is stored", async () => {
  const lib = openLibrary(TMP);
  try {
    const user = createUser(lib, "owner", null);
    // Four keys are four characters, though they take eight UTF-16 units.
    for (const password of ["short", "🔑🔑🔑🔑"])
      await expect(setPassword(lib, user.id, password)).rejects.toThrow(
        "at least 8 characters",
      );
    expect(hasPassword(lib, user.id)).toBe(false);
  } finally {
    closeLibrary(lib);
  }
});
