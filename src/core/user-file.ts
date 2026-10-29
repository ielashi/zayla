/**
 * A user's `users/<id>.yaml`: who they are, how they sign in (a password hash
 * and their passkeys), the sessions they are signed in with, which Person is
 * Me, their Provider with its key, and their Reading languages. The file is
 * named by the user's id, so it doesn't repeat it.
 *
 * The password is only ever here as its argon2id hash. The Provider's key is
 * kept as given, as it always has been. Login challenges are not here: they
 * live for a few minutes in the server's memory (see auth.ts).
 *
 * Fields are written for a person to read. A field a file lacks reads as its
 * default, so an older file stays readable as fields are added. Nothing but
 * this module knows the file's shape.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { DEFAULT_READING_LANGUAGES } from "../languages.ts";
import type { ProviderKind } from "../shared.ts";
import type { CredentialRecord } from "./auth.ts";
import type { SavedProvider } from "./enrich.ts";
import { userFilePath, usersDir } from "./library.ts";
import { isOpenRouterAddress, openRouterAddress } from "./openrouter.ts";
import { readYamlFileSync, writeYamlFileSync } from "./yaml.ts";

/** One signed-in session: the token the cookie carries, and when it lapses. */
export type SessionRecord = {
  token: string;
  createdAt: string;
  expiresAt: string;
};

/** Everything the Library keeps about one user, as auth.ts and the rest work with it. */
export type UserState = {
  id: string;
  username: string;
  displayName: string | null;
  createdAt: string;
  /** Null for a user with no password: a passkey alone is still a way in. */
  passwordHash: string | null;
  /** In order of preference; never empty. */
  readingLanguages: string[];
  /**
   * The Person this user marked as Me: the one they named, not the one that
   * answers for them now, so a Merge made since is followed when Me is read.
   */
  me: { entityId: number; markedAt: string } | null;
  provider: SavedProvider | null;
  passkeys: CredentialRecord[];
  sessions: SessionRecord[];
};

type PasskeyFile = {
  id: string;
  public_key: string; // base64url
  counter: number;
  transports?: AuthenticatorTransportFuture[] | null;
  device_type?: string | null;
  backed_up?: boolean;
  created_at: string;
  last_used_at?: string | null;
};

type UserFile = {
  username: string;
  display_name: string | null;
  created_at: string;
  password_hash: string | null;
  reading_languages: string[];
  me: { person: number; marked_at: string } | null;
  provider: {
    /** Absent from files written before OpenRouter was its own kind. */
    kind?: ProviderKind;
    base_url: string;
    model: string;
    api_key?: string | null;
    /** OpenRouter only; absent reads as on. */
    zero_retention?: boolean;
    chosen_at: string;
  } | null;
  passkeys: PasskeyFile[];
  sessions: { token: string; created_at: string; expires_at: string }[];
};

const DEFAULTS: UserFile = {
  username: "",
  display_name: null,
  created_at: "",
  password_hash: null,
  reading_languages: [...DEFAULT_READING_LANGUAGES],
  me: null,
  provider: null,
  passkeys: [],
  sessions: [],
};

function toFile(user: UserState): Partial<UserFile> {
  const file: Partial<UserFile> = {
    username: user.username,
    display_name: user.displayName,
    created_at: user.createdAt,
    password_hash: user.passwordHash,
    reading_languages: user.readingLanguages,
  };
  if (user.me)
    file.me = { person: user.me.entityId, marked_at: user.me.markedAt };
  if (user.provider)
    file.provider = {
      kind: user.provider.kind,
      base_url: user.provider.baseUrl,
      model: user.provider.model,
      api_key: user.provider.apiKey,
      ...(user.provider.kind === "openrouter"
        ? { zero_retention: user.provider.zeroRetention }
        : {}),
      chosen_at: user.provider.chosenAt,
    };
  file.passkeys = user.passkeys.map((p) => ({
    id: p.id,
    public_key: Buffer.from(p.publicKey).toString("base64url"),
    counter: p.counter,
    transports: p.transports,
    device_type: p.deviceType,
    backed_up: p.backedUp,
    created_at: p.createdAt,
    last_used_at: p.lastUsedAt,
  }));
  file.sessions = user.sessions.map((s) => ({
    token: s.token,
    created_at: s.createdAt,
    expires_at: s.expiresAt,
  }));
  return file;
}

/**
 * A Provider as its file has it. A file from before OpenRouter was its own
 * kind names only an address: one at OpenRouter's is an OpenRouter Provider,
 * with Zero retention on like any newly chosen, and any other is Custom. An
 * OpenRouter Provider is at OpenRouter's one address however its file spelled
 * it, so the key held for it still goes there.
 */
function providerFromFile(p: NonNullable<UserFile["provider"]>): SavedProvider {
  const kind =
    p.kind ?? (isOpenRouterAddress(p.base_url) ? "openrouter" : "custom");
  return {
    kind,
    baseUrl: kind === "openrouter" ? openRouterAddress() : p.base_url,
    model: p.model,
    apiKey: p.api_key ?? null,
    zeroRetention: kind === "openrouter" && p.zero_retention !== false,
    chosenAt: p.chosen_at,
  };
}

function fromFile(id: string, file: UserFile): UserState {
  const languages = Array.isArray(file.reading_languages)
    ? file.reading_languages.map(String)
    : [];
  return {
    id,
    username: String(file.username),
    displayName: file.display_name ?? null,
    createdAt: file.created_at,
    passwordHash: file.password_hash ?? null,
    readingLanguages:
      languages.length > 0 ? languages : [...DEFAULT_READING_LANGUAGES],
    me: file.me
      ? { entityId: file.me.person, markedAt: file.me.marked_at }
      : null,
    provider: file.provider ? providerFromFile(file.provider) : null,
    passkeys: (file.passkeys ?? []).map((p) => ({
      id: p.id,
      userId: id,
      publicKey: new Uint8Array(Buffer.from(p.public_key, "base64url")),
      counter: p.counter,
      transports: p.transports ?? null,
      deviceType: p.device_type ?? null,
      backedUp: p.backed_up === true,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at ?? null,
    })),
    sessions: (file.sessions ?? []).map((s) => ({
      token: s.token,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    })),
  };
}

/** Write one user's file, whole or not at all. */
export function writeUserFile(root: string, user: UserState): void {
  mkdirSync(usersDir(root), { recursive: true });
  writeYamlFileSync(userFilePath(root, user.id), toFile(user));
}

/** Every user of the Library at `root`, read from their files, by id. */
export function readUserFiles(root: string): Map<string, UserState> {
  let names: string[];
  try {
    names = readdirSync(usersDir(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const users = new Map<string, UserState>();
  for (const name of names) {
    if (!name.endsWith(".yaml")) continue;
    const id = name.slice(0, -".yaml".length);
    const file = readYamlFileSync(userFilePath(root, id), DEFAULTS);
    if (file) users.set(id, fromFile(id, file));
  }
  return users;
}

/** Remove every user's file. */
export function removeUserFiles(root: string): void {
  rmSync(usersDir(root), { recursive: true, force: true });
}
