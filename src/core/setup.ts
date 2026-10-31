/**
 * Setup: how a Library with no user gets its owner. It exists exactly while
 * there is no user, and is guarded by a one-time code the server prints to its
 * logs at boot, so whoever reaches an exposed port first can't claim the
 * Library. The HTTP endpoints live in ../api/setup.ts.
 */

import { timingSafeEqual } from "node:crypto";
import {
  countUsers,
  createUser,
  hashPassword,
  type UserRecord,
} from "./auth.ts";
import type { Library } from "./db.ts";
import { type ProviderChoice, resolveChoice } from "./enrich.ts";

/** Crockford's base32: no I, L, O or U, so nothing in a log is misread. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A fresh Setup code: 12 characters in groups of four, 60 bits, far too many
 * to guess over the network. Never stored; it lives as long as the process
 * that printed it.
 */
export function newSetupCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/**
 * A code as typed, compared without its case, spaces or dashes, and with the
 * letters base32 leaves out read as the digits they look like.
 */
const normalized = (code: string) =>
  code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

/** Whether `typed` is the Setup code `expected`, compared in constant time. */
export function isSetupCode(typed: unknown, expected: string): boolean {
  if (typeof typed !== "string") return false;
  const a = Buffer.from(normalized(typed));
  const b = Buffer.from(normalized(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Thrown when Setup is finished a second time: a user already exists. */
export class SetupClosed extends Error {
  constructor() {
    super("this library already has an owner");
  }
}

/** What Setup asks for. The password has passed `isAcceptablePassword`. */
export type SetupChoices = {
  password: string;
  readingLanguages: string[];
  /** Null when the Provider step was skipped. */
  provider: ProviderChoice | null;
};

/**
 * Create the owner with everything Setup asked, written in one file at once,
 * so no user can exist without a password.
 */
export async function completeSetup(
  lib: Library,
  choices: SetupChoices,
): Promise<UserRecord> {
  const hash = await hashPassword(choices.password);
  // Checked after hashing, which awaits: two Setups racing are told apart here.
  if (countUsers(lib) > 0) throw new SetupClosed();
  const { provider } = choices;
  return createUser(lib, "owner", "owner", {
    passwordHash: hash,
    readingLanguages: choices.readingLanguages,
    provider: provider && {
      ...resolveChoice(provider),
      chosenAt: new Date().toISOString(),
    },
  });
}
