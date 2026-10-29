/**
 * Authentication data-access (users, password hashes, passkey credentials,
 * sessions, challenges) plus cookie/session helpers. Users are held on the
 * Library handle and each written to their own `users/<id>.yaml` (see
 * user-file.ts) whenever they change; login challenges live only in memory.
 * The HTTP endpoints, WebAuthn ceremonies included, live in ../api/auth.ts;
 * this file only persists and retrieves.
 */

import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { DEFAULT_READING_LANGUAGES } from "../languages.ts";
import type { Library } from "./db.ts";
import type { SavedProvider } from "./enrich.ts";
import { removeUserFiles, type UserState, writeUserFile } from "./user-file.ts";

export const SESSION_COOKIE = "zayla_session";
export const CHALLENGE_COOKIE = "zayla_challenge";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type UserRecord = {
  id: string;
  username: string;
  displayName: string | null;
  createdAt: string;
};

export type CredentialRecord = {
  id: string; // credential ID (base64url)
  userId: string;
  // ArrayBuffer-backed to satisfy @simplewebauthn's WebAuthnCredential.publicKey.
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: AuthenticatorTransportFuture[] | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

/** A URL-safe random token of `bytes` bytes of entropy. */
function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

/**
 * Replace a user with `next`: their file first, and the Library's memory only
 * once it is written, so a write that fails leaves the user as they were.
 */
export function updateUser(lib: Library, next: UserState): void {
  writeUserFile(lib.root, next);
  lib.users.set(next.id, next);
}

function requireUser(lib: Library, userId: string): UserState {
  const user = lib.users.get(userId);
  if (!user) throw new Error(`no user with id: ${userId}`);
  return user;
}

const toRecord = (user: UserState): UserRecord => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  createdAt: user.createdAt,
});

// ---- users ----

export function countUsers(lib: Library): number {
  return lib.users.size;
}

/** What a user can be created with besides their name, all in one write. */
export type NewUser = {
  passwordHash?: string;
  readingLanguages?: string[];
  provider?: SavedProvider | null;
};

/**
 * Create a user and write their file. What `init` names is in that one write,
 * so a user created with a password never exists without it.
 */
export function createUser(
  lib: Library,
  username: string,
  displayName: string | null,
  init: NewUser = {},
): UserRecord {
  if ([...lib.users.values()].some((u) => u.username === username))
    throw new Error(`a user named ${username} already exists`);
  const user: UserState = {
    id: crypto.randomUUID(),
    username,
    displayName,
    createdAt: new Date().toISOString(),
    passwordHash: init.passwordHash ?? null,
    readingLanguages: init.readingLanguages ?? [...DEFAULT_READING_LANGUAGES],
    me: null,
    provider: init.provider ?? null,
    passkeys: [],
    sessions: [],
  };
  updateUser(lib, user);
  return toRecord(user);
}

export function listUsers(lib: Library): UserRecord[] {
  return [...lib.users.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toRecord);
}

export function getUser(lib: Library, id: string): UserRecord | null {
  const user = lib.users.get(id);
  return user ? toRecord(user) : null;
}

// ---- passwords ----

/** The one rule a password has to meet. */
export const MIN_PASSWORD_LENGTH = 8;

/** What to tell someone whose password breaks that rule. */
export const PASSWORD_RULE = `a password needs at least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * Whether `password` can be used. Characters are counted as a person sees
 * them, so an emoji is one, not the two UTF-16 units it takes.
 */
export function isAcceptablePassword(password: unknown): password is string {
  return (
    typeof password === "string" && [...password].length >= MIN_PASSWORD_LENGTH
  );
}

/**
 * Give `userId` this password, replacing any they had. Only the argon2id hash
 * is stored. Passkeys, sessions and Me are left as they are, which is what
 * lets the CLI use this to reset a forgotten password.
 */
export async function setPassword(
  lib: Library,
  userId: string,
  password: string,
): Promise<void> {
  storePasswordHash(lib, userId, await hashPassword(password));
}

/**
 * The argon2id hash of an acceptable password. Hashing is slow and async, so a
 * caller that must create a user with their password in one write hashes
 * first and creates the user with the hash.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!isAcceptablePassword(password)) throw new Error(PASSWORD_RULE);
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Give `userId` a password already hashed by `hashPassword`. */
export function storePasswordHash(
  lib: Library,
  userId: string,
  hash: string,
): void {
  updateUser(lib, { ...requireUser(lib, userId), passwordHash: hash });
}

export function hasPassword(lib: Library, userId: string): boolean {
  return (lib.users.get(userId)?.passwordHash ?? null) !== null;
}

/** Whether `password` is `userId`'s. False for a user who has none. */
export async function verifyPassword(
  lib: Library,
  userId: string,
  password: string,
): Promise<boolean> {
  const hash = lib.users.get(userId)?.passwordHash ?? null;
  return hash !== null && (await Bun.password.verify(password, hash));
}

/** A hash of nothing anyone knows, checked when nobody has a password. */
let decoyHash: Promise<string> | null = null;

/**
 * The user whose password this is, or null. No username is asked while the
 * Library has one user, so every user with a password is tried. With nobody
 * to try, a decoy hash is checked anyway, so a refusal takes as long whether
 * or not a password exists.
 */
export async function userWithPassword(
  lib: Library,
  password: string,
): Promise<UserRecord | null> {
  const withPassword = [...lib.users.values()].filter(
    (u): u is UserState & { passwordHash: string } => u.passwordHash !== null,
  );
  if (withPassword.length === 0) {
    decoyHash ??= Bun.password.hash(crypto.randomUUID(), {
      algorithm: "argon2id",
    });
    await Bun.password.verify(password, await decoyHash);
    return null;
  }
  for (const user of withPassword)
    if (await Bun.password.verify(password, user.passwordHash))
      return getUser(lib, user.id);
  return null;
}

// ---- credentials (passkeys) ----

const copyOf = (c: CredentialRecord): CredentialRecord => ({
  ...c,
  publicKey: new Uint8Array(c.publicKey),
  transports: c.transports ? [...c.transports] : null,
});

export function insertCredential(
  lib: Library,
  rec: {
    id: string;
    userId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: AuthenticatorTransportFuture[] | undefined;
    deviceType: string;
    backedUp: boolean;
  },
): void {
  if (getCredentialById(lib, rec.id))
    throw new Error(`a passkey with id ${rec.id} is already registered`);
  const user = requireUser(lib, rec.userId);
  updateUser(lib, {
    ...user,
    passkeys: [
      ...user.passkeys,
      {
        id: rec.id,
        userId: rec.userId,
        publicKey: new Uint8Array(rec.publicKey),
        counter: rec.counter,
        transports: rec.transports ?? null,
        deviceType: rec.deviceType,
        backedUp: rec.backedUp,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      },
    ],
  });
}

function findCredential(
  lib: Library,
  id: string,
): { user: UserState; passkey: CredentialRecord } | null {
  for (const user of lib.users.values()) {
    const passkey = user.passkeys.find((p) => p.id === id);
    if (passkey) return { user, passkey };
  }
  return null;
}

export function getCredentialById(
  lib: Library,
  id: string,
): CredentialRecord | null {
  const found = findCredential(lib, id);
  return found ? copyOf(found.passkey) : null;
}

export function listCredentialsForUser(
  lib: Library,
  userId: string,
): CredentialRecord[] {
  return (lib.users.get(userId)?.passkeys ?? []).map(copyOf);
}

export function updateCredentialCounter(
  lib: Library,
  id: string,
  counter: number,
): void {
  const found = findCredential(lib, id);
  if (!found) return;
  const lastUsedAt = new Date().toISOString();
  updateUser(lib, {
    ...found.user,
    passkeys: found.user.passkeys.map((p) =>
      p.id === id ? { ...p, counter, lastUsedAt } : p,
    ),
  });
}

// ---- sessions ----

const lapsed = (expiresAt: string, now: number) => Date.parse(expiresAt) < now;

/** Create a session for `userId`; returns the opaque token to put in the cookie. */
export function createSession(lib: Library, userId: string): string {
  const user = requireUser(lib, userId);
  const token = randomToken();
  const now = Date.now();
  // Sessions that have lapsed go while the file is being written anyway.
  updateUser(lib, {
    ...user,
    sessions: [
      ...user.sessions.filter((s) => !lapsed(s.expiresAt, now)),
      {
        token,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      },
    ],
  });
  return token;
}

function findSession(lib: Library, token: string) {
  for (const user of lib.users.values()) {
    const session = user.sessions.find((s) => s.token === token);
    if (session) return { user, session };
  }
  return null;
}

/** Resolve a session token to its user id, or null if missing/expired (expired ones are pruned). */
export function getSessionUserId(lib: Library, token: string): string | null {
  const found = findSession(lib, token);
  if (!found) return null;
  if (lapsed(found.session.expiresAt, Date.now())) {
    deleteSession(lib, token);
    return null;
  }
  return found.user.id;
}

export function deleteSession(lib: Library, token: string): void {
  const found = findSession(lib, token);
  if (!found) return;
  updateUser(lib, {
    ...found.user,
    sessions: found.user.sessions.filter((s) => s.token !== token),
  });
}

/**
 * Remove every user — and with them their passkeys, sessions, Me, Provider
 * and key — and every challenge in flight: the recovery escape hatch (CLI).
 */
export function clearAllAuth(lib: Library): void {
  removeUserFiles(lib.root);
  lib.users.clear();
  lib.challenges.clear();
}

// ---- challenges (short-lived, one per in-flight ceremony) ----
//
// Held only in the server's memory: a challenge lives for minutes, and a
// restart in the middle of a sign-in costs nothing but trying again.

/** Hold a ceremony challenge; returns the id to carry in the challenge cookie. */
export function putChallenge(lib: Library, challenge: string): string {
  const id = randomToken(18);
  lib.challenges.set(id, { challenge, createdAt: Date.now() });
  return id;
}

/** Consume a challenge by id: forget it and return its value, or null if missing/expired. */
export function takeChallenge(lib: Library, id: string): string | null {
  const held = lib.challenges.get(id);
  lib.challenges.delete(id);
  // Sweep other stale challenges while we're here.
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [other, c] of lib.challenges)
    if (c.createdAt < cutoff) lib.challenges.delete(other);
  if (!held || held.createdAt < cutoff) return null;
  return held.challenge;
}

// ---- cookies ----

/** Parse the request's Cookie header into a name→value map. */
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Whether the browser reached us over HTTPS. Behind a TLS-terminating proxy
 * the request itself is plain HTTP, so the browser's Origin and the proxy's
 * X-Forwarded-Proto say what the browser actually saw. Not RP_ORIGIN: the same
 * Library may also be opened at a LAN address over plain HTTP, where a Secure
 * cookie would never be sent back.
 */
function cameOverHttps(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin.startsWith("https://");
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(req.url).protocol === "https:";
}

function cookie(
  req: Request,
  name: string,
  value: string,
  maxAgeSec: number,
): string {
  const attrs = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (cameOverHttps(req)) attrs.push("Secure");
  return attrs.join("; ");
}

export const sessionCookie = (req: Request, token: string) =>
  cookie(req, SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000));
export const clearSessionCookie = (req: Request) =>
  cookie(req, SESSION_COOKIE, "", 0);
export const challengeCookie = (req: Request, id: string) =>
  cookie(req, CHALLENGE_COOKIE, id, Math.floor(CHALLENGE_TTL_MS / 1000));
export const clearChallengeCookie = (req: Request) =>
  cookie(req, CHALLENGE_COOKIE, "", 0);

/** The authenticated user for this request, or null. Reads the session cookie. */
export function requireAuth(lib: Library, req: Request): UserRecord | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const userId = getSessionUserId(lib, token);
  if (!userId) return null;
  return getUser(lib, userId);
}
