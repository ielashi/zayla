/**
 * How a Document's Enrichment becomes Appearances: the names a Document names,
 * each with the role it played and, where the Document says so, the Organization
 * a Person acted for.
 *
 * This module is deliberately dependency-free in the same sense as shared.ts: it
 * takes no database handle, performs no input or output, and touches no DOM. It
 * owns the name problem that needs no Library: what the Appearances of a reading
 * are, the form in which two spellings are one name, and whether two spellings
 * look like one name. `entities.ts` decides which Person or Organization each
 * Appearance resolves to, and which entities to put to the owner as look-alikes.
 */

import type { AppearanceRole, EntityKind, Party } from "../shared.ts";

// What kind of thing a name names, and the part it played. Both ends of the
// wire read them, so they are declared in shared.ts and re-exported here, where
// the rest of the domain reads its vocabulary.
export type { AppearanceRole, EntityKind } from "../shared.ts";

/** The roles in their canonical order: the parties first, then the names merely named. */
export const ROLE_ORDER: AppearanceRole[] = ["sender", "receiver", "mentioned"];

/**
 * One Appearance as read out of an Enrichment, before it is resolved to an
 * entity: a name rather than an id, so this stays independent of the Library.
 */
export type DerivedAppearance = {
  kind: EntityKind;
  /** The name as the Document wrote it, whitespace-tidied but not rewritten. */
  name: string;
  role: AppearanceRole;
  /** For a Person, the Organization they acted for here; null when none is named. */
  affiliation: string | null;
};

/** The fields of an Enrichment that name people and organizations. */
export type AppearanceSource = {
  sender: Party | null;
  receiver: Party | null;
  people: string[] | null;
};

/**
 * Separators that mean "this field holds more than one name", whatever kind of
 * name it holds. A comma is not among them: it is how a surname comes first
 * ("Okafor, Jordan"), and how a legal suffix is attached ("Acme, Inc.").
 */
const SEPARATORS = /[\n;|/]+/;

/**
 * Separators that only ever mean two names when the names are people. A Person
 * is never called "Jordan and Jana", so a conjunction in that field is two
 * signatories; an Organization may well be "Schmidt and Partners" or "Müller &
 * Partner", so there it is part of the name.
 */
const PERSON_SEPARATORS = /\s+(?:and|und|et|&)\s+/i;

/**
 * What a model writes when a party is absent. Matched exactly against the
 * normalized name, so punctuation and case don't matter ("N/A" and "-"
 * normalize to nothing a name could be). Exact match is the point: a phrase
 * this doesn't recognize becomes an entity the owner can see and merge away,
 * which is a better failure than guessing that a real name means "absent".
 */
const PLACEHOLDERS = new Set([
  "unknown",
  "unknown sender",
  "unknown recipient",
  "unbekannt",
  "absender unbekannt",
  "none",
  "null",
  "na",
  "n n", // "N.N.", the German form for a name left open
  "nil",
  "not specified",
  "unspecified",
  "not given",
  "nicht angegeben",
  "keine angabe",
]);

/**
 * The form in which two spellings of one name are the same name: casefolded,
 * stripped of diacritics and punctuation, whitespace collapsed. Exact match on
 * this is what resolves a name to a known entity, so it is forgiving about how a
 * name is written and nothing else — "Jordan Okafor" is not "Jana Okafor".
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // the combining marks the decomposition left
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Does one part of a name stand for another? Either they are the same word, or
 * one is an initial the other begins with — which is how "J. Okafor" is written
 * for "Jordan Okafor".
 */
function standsFor(one: string, other: string): boolean {
  if (one === other) return true;
  if (one.length === 1) return other.startsWith(one);
  if (other.length === 1) return one.startsWith(other);
  return false;
}

/**
 * Do two spellings look like one name? This is the judgement behind the
 * duplicates Zayla points out — points out rather than acts on, because a
 * suggestion the owner declines costs nothing, where silently welding two
 * different people together would cost them a Library they can trust.
 *
 * Two spellings look alike when they share at least one whole word, and every
 * other part of the shorter spelling is answered for by a part of the longer
 * one — in any order, an initial standing for the part it begins. That catches
 * a name written surname-first, a name with a part dropped, and a given name
 * shortened to an initial, while leaving two people who share a surname as two
 * people: "Jana Okafor" has a part "Jordan Okafor" cannot answer for, so
 * neither stands for the other.
 *
 * Two conditions keep the suggestions worth reading. The shorter spelling must
 * name at least two parts, so a bare surname is not offered as every relative
 * who shares it; and the shared whole word is required, so initials on their
 * own ("J. O."), which belong to far too many people, are not either.
 *
 * Spellings differing only in case, punctuation, diacritics or whitespace are
 * one name outright — they already resolve to one entity, so this says so for
 * the sake of callers asking about two names rather than two entities.
 */
export function looksLikeSameName(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;

  const one = left.split(" ");
  const other = right.split(" ");
  const shorter = one.length <= other.length ? one : other;
  const longer = shorter === one ? other : one;
  if (shorter.length < 2) return false;

  // The whole words the two spellings share, one word answering for one word.
  // These are claimed before any initial is, so that a middle initial cannot
  // take the word that was going to be the pair's anchor: "A. M. Meier" has an
  // "m" that could stand for "Meier", and letting it would leave "Anna Meier"
  // with no shared word and no suggestion.
  const anchored = new Set<number>(); // the parts of the longer spelling spoken for
  const leftovers: string[] = [];
  for (const part of shorter) {
    const shared =
      part.length > 1
        ? longer.findIndex(
            (word, index) => word === part && !anchored.has(index),
          )
        : -1;
    if (shared === -1) leftovers.push(part);
    else anchored.add(shared);
  }
  if (anchored.size === 0) return false;

  // Every part left over — the initials, and the parts written only one way —
  // must be answered for by a part of the longer spelling nothing else has
  // taken. That one part answers for one part is what makes the surname shared
  // by "Jordan Okafor" and "Jana Okafor" insufficient on its own: with "okafor"
  // anchored, "jordan" has nothing left to stand for. A part already claimed
  // gives way when the leftover holding it has another option.
  const claims = new Map<number, number>(); // longer part → leftover part
  const claim = (leftover: number, tried: Set<number>): boolean => {
    for (const [candidate, word] of longer.entries()) {
      if (anchored.has(candidate) || tried.has(candidate)) continue;
      if (!standsFor(leftovers[leftover] ?? "", word)) continue;
      tried.add(candidate);
      const held = claims.get(candidate);
      if (held === undefined || claim(held, tried)) {
        claims.set(candidate, leftover);
        return true;
      }
    }
    return false;
  };
  return leftovers.every((_, leftover) => claim(leftover, new Set()));
}

/** Collapse a name's whitespace without touching how it is spelled. */
function tidy(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Is this a name at all? A single character isn't one, which also discards the
 * fragments a placeholder leaves behind when a separator runs through it ("n/a"
 * → "n", "a").
 */
function isName(name: string): boolean {
  const normalized = normalizeName(name);
  return normalized.length > 1 && !PLACEHOLDERS.has(normalized);
}

/**
 * The names a party field holds — one in the ordinary case, more when a model
 * crowded several in. Placeholders and empty fields yield none. The kind decides
 * how hard the field is split: a Person field also parts on a conjunction, where
 * an Organization's name may contain one.
 *
 * The Enrichment prompt asks for one person per party; this is the net under a
 * model that crowds several in anyway.
 */
export function splitNames(field: string, kind: EntityKind): string[] {
  const seen = new Set<string>();
  return field
    .split(SEPARATORS)
    .flatMap((part) =>
      kind === "person" ? part.split(PERSON_SEPARATORS) : [part],
    )
    .map(tidy)
    .filter((name) => {
      if (!isName(name)) return false;
      const key = normalizeName(name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The Appearances a reading yields: each party's Organization and Person in that
 * party's role, then the names the Document merely names, as Mentioned.
 *
 * A Person is affiliated to the Organization of the party they appeared in, and
 * only when that party names exactly one Organization — two would make the
 * affiliation a guess. The affiliation belongs to the Appearance, not to the
 * Person: the same Person may act for a different Organization in the next
 * Document.
 *
 * A name that already appears as a party is not also recorded as Mentioned, so
 * the roles a listing shows are the parts the name actually played rather than
 * "sender, mentioned" on every sender a model also listed in `people`.
 */
export function deriveAppearances(
  reading: AppearanceSource,
): DerivedAppearance[] {
  const out: DerivedAppearance[] = [];
  const recorded = new Set<string>();
  /** Everyone who played a party's part here, whatever the party. */
  const parties = new Set<string>();
  const add = (a: DerivedAppearance) => {
    const key = `${a.kind}\u0000${normalizeName(a.name)}\u0000${a.role}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    out.push(a);
  };

  for (const [role, party] of [
    ["sender", reading.sender],
    ["receiver", reading.receiver],
  ] as const) {
    if (!party) continue;
    const organizations = splitNames(party.organization, "organization");
    for (const name of organizations)
      add({ kind: "organization", name, role, affiliation: null });
    const affiliation =
      organizations.length === 1 ? (organizations[0] ?? null) : null;
    for (const name of splitNames(party.person, "person")) {
      add({ kind: "person", name, role, affiliation });
      parties.add(normalizeName(name));
    }
  }

  for (const entry of reading.people ?? [])
    for (const name of splitNames(entry, "person")) {
      // Already a party to this Document: it played that part, not this one.
      if (parties.has(normalizeName(name))) continue;
      add({ kind: "person", name, role: "mentioned", affiliation: null });
    }

  return out;
}
