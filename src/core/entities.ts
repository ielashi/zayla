/**
 * The People and Organizations the Library's Documents involve, the Appearances
 * that tie them to a Document, the Merges that say two names are one, and which
 * Person each user has marked as Me.
 *
 * The naming — every entity with its display name and Name variants, and every
 * Merge — is kept in `naming.yaml` (see naming-file.ts) and held in memory on
 * the Library handle. Appearances are not kept anywhere: they follow from each
 * Document's Enrichment through `deriveAppearances`, and are worked out again
 * when the Library is opened and whenever a Document is read. This module
 * resolves the names `appearances.ts` derived to entities, reads the list back,
 * merges two names on the owner's word, and remembers which of the People each
 * user is (in that user's own file).
 */

import {
  type AppearanceRole,
  deriveAppearances,
  type EntityKind,
  looksLikeSameName,
  normalizeName,
  ROLE_ORDER,
} from "./appearances.ts";
import { updateUser } from "./auth.ts";
import type { DocumentRecord, Library } from "./db.ts";
import {
  type EntityRecord,
  type MergeRecord,
  type NamingRecord,
  readNamingFile,
  writeNamingFile,
} from "./naming-file.ts";

/**
 * One Organization a Person appeared for, named and identified. The id is what
 * nests a Person under the Organization they acted for: two Organizations may
 * yet be written the same way, so the name alone cannot say which one this is.
 */
export type Affiliation = { id: number; displayName: string };

/** A Person or an Organization, with what the Library has seen it do. */
export type EntityListing = {
  id: number;
  kind: EntityKind;
  /** The name shown for this entity. */
  displayName: string;
  /**
   * Distinct Documents this entity appears in — counted once per Document
   * whatever the role, so a Document that both addresses someone and names them
   * inside doesn't inflate the total. After a Merge this is the Documents of
   * every name merged in, still counted once each.
   */
  documents: number;
  /** The parts this entity played, in sender/receiver/mentioned order. */
  roles: AppearanceRole[];
  /** For a Person, the Organizations they appeared for; empty for an Organization. */
  affiliations: Affiliation[];
  /** The names merged into this one, which it now answers to as well. */
  mergedNames: NamedEntity[];
};

/**
 * Everything one entity's own page is built from: what a listing says about it,
 * every spelling it has been written as, and the Documents it appears in under
 * each part it played.
 */
export type EntityDetail = EntityListing & {
  /**
   * Every spelling this entity has been written as, the spellings of the names
   * merged into it included — which is what lets a Merge be checked rather than
   * taken on trust. In the order the Library learned them: each name's first
   * spelling as the name was met, then those its Merges taught it.
   */
  variants: string[];
  /**
   * The Documents this entity appears in, grouped by the part it played, in
   * sender/receiver/mentioned order. A part it never played is absent rather
   * than empty.
   *
   * These are not the entity's Appearances: an entity that both sent a Document
   * and is named inside it has two of those, and is filed here once, under the
   * part that says the most about the Document. Nor are they the `roles` of the
   * listing above, which are the parts played and nothing more. See the
   * grouping in `entityDetail`.
   */
  documentsByRole: { role: AppearanceRole; hashes: string[] }[];
  /**
   * The listed entities of the same kind whose names look like this one's, for
   * the owner to confirm or leave alone — read off the same listing the page
   * itself is built from, because the page is where a Merge is made and so
   * where the question belongs. Nothing here has been merged.
   */
  suspected: EntityListing[];
};

/** An entity as the Merge commands name it: which one, and what it is called. */
export type NamedEntity = { id: number; displayName: string };

/** A surviving name, with the Documents it now covers. */
export type SurvivingName = NamedEntity & { documents: number };

/** An entity as named on the command line, before anything is done to it. */
export type EntityRef = {
  id: number;
  kind: EntityKind;
  displayName: string;
  /** The entity this one was merged into, or null when it answers for itself. */
  mergedInto: number | null;
};

/**
 * A statement about naming the Library will not make, carrying the reason the
 * owner reads — a Person who cannot be Me being the plainest case.
 *
 * A refusal is a statement about what was asked rather than a failure of the
 * Library, and the two must not read alike: a caller can hand a refusal to the
 * owner as the answer to what they asked, where a Library that would not
 * answer is not something they did.
 */
export class Refused extends Error {}

/**
 * A Merge the Library refuses, carrying the reason the owner reads: two names
 * of different kinds, two names already one, a spelling a third name holds, a
 * name no Merge took in, an id that is nobody's.
 */
export class MergeRefused extends Refused {}

/** What the owner chose about the surviving name when merging. */
export type MergeChoice = {
  /** The name to show from now on; the most frequent variant when omitted. */
  displayName?: string;
};

/** What a Merge did: which name survived it, and which one it took in. */
export type MergeOutcome = {
  survivor: SurvivingName;
  absorbed: NamedEntity;
};

/** What taking a Merge back did: the two names it leaves behind. */
export type UnmergeOutcome = {
  survivor: SurvivingName;
  restored: SurvivingName;
};

/**
 * Two entities of one kind whose names look like they belong to one Person or
 * one Organization. A suggestion is a question put to the owner, nothing more.
 */
export type DuplicateSuggestion = {
  kind: EntityKind;
  /**
   * The pair, in the order the listing has them — so the entity with more
   * Documents comes first, which is usually the name worth keeping.
   */
  entities: [EntityListing, EntityListing];
};

// ---- the naming in memory ---------------------------------------------------

/**
 * The Library's naming as held in memory: what `naming.yaml` holds, with every
 * spelling indexed by kind and normalized form, which is what resolves a name
 * read out of a Document to an entity already known.
 */
export type Naming = NamingRecord & {
  /** Entity id by `nameKey(kind, normalized spelling)`. */
  byName: Map<string, number>;
};

/**
 * One Appearance once its names are resolved: the entity the Document named,
 * the part it played, and the Organization a Person acted for there.
 */
export type Appearance = {
  entityId: number;
  role: AppearanceRole;
  affiliationId: number | null;
};

const nameKey = (kind: EntityKind, name: string) =>
  `${kind}\u0000${normalizeName(name)}`;

/** Read the naming of the Library at `root`, indexed for resolving names. */
export function readNaming(root: string): Naming {
  const record = readNamingFile(root);
  const byName = new Map<string, number>();
  for (const entity of record.entities.values())
    for (const variant of entity.variants) {
      const key = nameKey(entity.kind, variant);
      // Two spellings that normalize alike are one: the first learned holds it.
      if (!byName.has(key)) byName.set(key, entity.id);
    }
  return { ...record, byName };
}

/** A copy of `naming` to change, leaving the one in memory as it is. */
function copyOfNaming(naming: Naming): Naming {
  return {
    nextId: naming.nextId,
    entities: new Map(
      [...naming.entities].map(([id, e]) => [
        id,
        { ...e, variants: [...e.variants] },
      ]),
    ),
    merges: naming.merges.map((m) => ({ ...m })),
    byName: new Map(naming.byName),
  };
}

/**
 * Change the naming: `change` works on a copy, which is written to
 * `naming.yaml` (when `write` says so) and only then becomes the naming in
 * memory, so a write that fails leaves the Library as it was.
 */
function changeNaming<T>(
  lib: Library,
  change: (next: Naming) => T,
  write: (result: T) => boolean = () => true,
): T {
  const next = copyOfNaming(lib.naming);
  const result = change(next);
  if (write(result)) writeNamingFile(lib.root, next);
  Object.assign(lib.naming, next);
  return result;
}

/**
 * The entity a name belongs to, creating one when the spelling is unseen. A
 * spelling already known resolves to its existing entity however it is written;
 * an unseen one starts a new entity displayed under that spelling, and is
 * learned as its first Name variant. Says whether it learned one, so the caller
 * knows the naming needs writing.
 *
 * A merged spelling resolves to the entity it was learned for, not to the one
 * that currently answers for it: an Appearance records the name the Document
 * actually used, which is what lets a Merge be taken back without losing track
 * of which Documents said which.
 */
function resolveEntity(
  naming: Naming,
  kind: EntityKind,
  name: string,
): { id: number; learned: boolean } {
  const key = nameKey(kind, name);
  const known = naming.byName.get(key);
  if (known !== undefined) return { id: known, learned: false };
  const id = naming.nextId++;
  naming.entities.set(id, { id, kind, displayName: name, variants: [name] });
  naming.byName.set(key, id);
  return { id, learned: true };
}

/** Appearances worked out, and whether working them out learned a spelling. */
type Derived<T> = { appearances: T; learned: boolean };

/**
 * Work out one Document's Appearances from its Enrichment, resolving its names
 * through `naming` and learning there any spelling seen for the first time.
 */
function deriveFor(naming: Naming, doc: DocumentRecord): Derived<Appearance[]> {
  let learned = false;
  const resolve = (kind: EntityKind, name: string) => {
    const r = resolveEntity(naming, kind, name);
    learned ||= r.learned;
    return r.id;
  };
  const appearances: Appearance[] = [];
  const seen = new Set<string>();
  for (const a of deriveAppearances(doc)) {
    const entityId = resolve(a.kind, a.name);
    const affiliationId =
      a.affiliation === null ? null : resolve("organization", a.affiliation);
    // Two spellings of one name in one part are one Appearance; the first
    // one's affiliation stands.
    const key = `${entityId}\u0000${a.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appearances.push({ entityId, role: a.role, affiliationId });
  }
  return { appearances, learned };
}

/**
 * Work out every Document's Appearances through `naming`, as opening the
 * Library does. The Documents are walked in a fixed order, so a spelling seen
 * for the first time takes the same id on every handle.
 */
function deriveAll(
  naming: Naming,
  documents: Iterable<DocumentRecord>,
): Derived<Map<string, Appearance[]>> {
  const docs = [...documents].sort(
    (a, b) =>
      a.addedAt.localeCompare(b.addedAt) || a.hash.localeCompare(b.hash),
  );
  const appearances = new Map<string, Appearance[]>();
  let learned = false;
  for (const doc of docs) {
    const one = deriveFor(naming, doc);
    learned ||= one.learned;
    if (one.appearances.length > 0) appearances.set(doc.hash, one.appearances);
  }
  return { appearances, learned };
}

/** Make `appearances` the Library's, in place of what it had. */
function replaceAppearances(
  lib: Library,
  appearances: Map<string, Appearance[]>,
): void {
  lib.appearances.clear();
  for (const [hash, list] of appearances) lib.appearances.set(hash, list);
}

/**
 * Record what one Document's reading says about who it involves, worked out
 * from its Enrichment, replacing whatever it had: a second reading of the same
 * Document is still one Document. The naming is written first when the
 * reading taught the Library a spelling it had not seen.
 */
export function recordAppearances(lib: Library, doc: DocumentRecord): void {
  const { appearances } = changeNaming(
    lib,
    (next) => deriveFor(next, doc),
    (derived) => derived.learned,
  );
  if (appearances.length > 0) lib.appearances.set(doc.hash, appearances);
  else lib.appearances.delete(doc.hash);
}

/**
 * Work out every Document's Appearances, as opening the Library does. Only the
 * Library's writer writes what was learned: a handle that only reads keeps it
 * in memory, and leaves the files to the writer.
 */
export function deriveAllAppearances(lib: Library): void {
  const { appearances } = changeNaming(
    lib,
    (next) => deriveAll(next, lib.documents.values()),
    (derived) => derived.learned && lib.lock !== null,
  );
  replaceAppearances(lib, appearances);
}

/** Forget a Document's Appearances, when it leaves the Library. Its naming stays. */
export function dropAppearances(lib: Library, hash: string): void {
  lib.appearances.delete(hash);
}

// ---- who answers for whom ----------------------------------------------------

/**
 * Every entity paired with the entity that answers for it: itself, or — once
 * the owner has merged it — whichever surviving name its Merges lead to.
 *
 * The walk starts from the entities nothing was merged into and follows the
 * Merges inwards, so a Merge that somehow pointed in a circle leaves those
 * names out rather than looping forever.
 */
function answersFor(naming: Naming): Map<number, number> {
  const absorbedInto = new Map<number, number[]>();
  const absorbed = new Set<number>();
  for (const m of naming.merges) {
    absorbed.add(m.absorbedId);
    const list = absorbedInto.get(m.survivorId);
    if (list) list.push(m.absorbedId);
    else absorbedInto.set(m.survivorId, [m.absorbedId]);
  }
  const out = new Map<number, number>();
  const stack: [number, number][] = [];
  for (const id of naming.entities.keys())
    if (!absorbed.has(id)) stack.push([id, id]);
  while (stack.length > 0) {
    const [id, survivor] = stack.pop() as [number, number];
    if (out.has(id) || !naming.entities.has(id)) continue;
    out.set(id, survivor);
    for (const next of absorbedInto.get(id) ?? []) stack.push([next, survivor]);
  }
  return out;
}

/** SQLite's NOCASE: ASCII letters folded, everything else compared as is. */
function byNameNoCase(a: string, b: string): number {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const [x, y] = [fold(a), fold(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

function entityIn(naming: Naming, id: number): EntityRecord {
  const found = naming.entities.get(id);
  if (!found) throw new Error(`no entity #${id}`);
  return found;
}

const entity = (lib: Library, id: number): EntityRecord =>
  entityIn(lib.naming, id);

/**
 * Every Person and Organization that appears in at least one Document, most
 * documents first and alphabetically among equals. A merged name is not listed
 * in its own right; it is listed as one of the names the surviving entity
 * answers to. An entity whose Documents have all been Deleted keeps its name
 * variants and its Merges but is not listed — there is nothing left to browse.
 */
export function listEntities(lib: Library): EntityListing[] {
  const answers = answersFor(lib.naming);
  const groups = new Map<
    number,
    { documents: Set<string>; roles: Set<AppearanceRole>; orgs: Set<number> }
  >();
  for (const [hash, appearances] of lib.appearances)
    for (const a of appearances) {
      const survivor = answers.get(a.entityId);
      if (survivor === undefined) continue;
      let group = groups.get(survivor);
      if (!group) {
        group = { documents: new Set(), roles: new Set(), orgs: new Set() };
        groups.set(survivor, group);
      }
      group.documents.add(hash);
      group.roles.add(a.role);
      // The Organization that answers for the affiliation now, not the one the
      // Appearance named: only a listed Organization can hold her.
      if (a.affiliationId !== null) {
        const org = answers.get(a.affiliationId);
        if (org !== undefined) group.orgs.add(org);
      }
    }

  const mergedNames = new Map<number, NamedEntity[]>();
  for (const [id, survivor] of answers) {
    if (id === survivor) continue;
    const name = { id, displayName: entity(lib, id).displayName };
    const seen = mergedNames.get(survivor);
    if (seen) seen.push(name);
    else mergedNames.set(survivor, [name]);
  }
  for (const names of mergedNames.values())
    names.sort((a, b) => byNameNoCase(a.displayName, b.displayName));

  return [...groups]
    .map(([id, group]): EntityListing => {
      const e = entity(lib, id);
      return {
        id,
        kind: e.kind,
        displayName: e.displayName,
        documents: group.documents.size,
        roles: ROLE_ORDER.filter((role) => group.roles.has(role)),
        affiliations: [...group.orgs]
          .map((org) => ({
            id: org,
            displayName: entity(lib, org).displayName,
          }))
          .sort((a, b) => byNameNoCase(a.displayName, b.displayName)),
        mergedNames: mergedNames.get(id) ?? [],
      };
    })
    .sort(
      (a, b) =>
        b.documents - a.documents || byNameNoCase(a.displayName, b.displayName),
    );
}

/**
 * One entity with everything its own page shows, or null when the id has no
 * page: nobody's id, or a name whose Documents have all been Deleted and which
 * therefore has nothing left to browse, exactly as the listing has it.
 *
 * A name the owner has merged away answers with the entity that answers for it
 * now, rather than with nothing: the Merge did not delete the name, and a
 * bookmark made before it was made is still a bookmark for that Person.
 */
export function entityDetail(lib: Library, id: number): EntityDetail | null {
  // A listed entity either is the id asked for or has merged it in, so the
  // listing resolves a merged-away id without a second walk of the Merges —
  // and leaves out, here as there, the names a circular Merge made unreachable.
  const listed = listEntities(lib);
  const listing = listed.find(
    (e) => e.id === id || e.mergedNames.some((merged) => merged.id === id),
  );
  if (!listing) return null;

  const answers = answersFor(lib.naming);
  const group = [...answers]
    .filter(([, survivor]) => survivor === listing.id)
    .map(([member]) => member)
    .sort((a, b) => a - b);
  // Each name's own first spelling, in the order the Library met the names,
  // then the spellings a Merge taught them: a name's first spelling is learned
  // when it is, and the rest only ever by a Merge, made once the names exist.
  const spellings = group.map((member) => entity(lib, member).variants);
  const variants = [
    ...spellings.flatMap((own) => own.slice(0, 1)),
    ...spellings.flatMap((own) => own.slice(1)),
  ];

  /**
   * The part each of the entity's Documents is filed under: the most prominent
   * one it played there. A Document is in one group rather than in every group
   * whose part the entity played, because the distinction the grouping exists
   * for is what an authority sent apart from the letters that merely name it —
   * and a letter it sent that also names it would be in both. It is also what
   * makes the groups add up to the count the listings show.
   */
  const members = new Set(group);
  const filedUnder = new Map<string, AppearanceRole>();
  for (const hash of [...lib.appearances.keys()].sort())
    for (const a of lib.appearances.get(hash) ?? []) {
      if (!members.has(a.entityId)) continue;
      const played = filedUnder.get(hash);
      if (!played || ROLE_ORDER.indexOf(a.role) < ROLE_ORDER.indexOf(played))
        filedUnder.set(hash, a.role);
    }

  // The entity's own look-alikes: the listed names of its kind that look like
  // the one it shows. A name merged away is not among them, because it is not
  // listed: a Merge already made is never put to the owner again as a question.
  const suspected = listed.filter(
    (e) =>
      e.id !== listing.id &&
      e.kind === listing.kind &&
      looksLikeSameName(e.displayName, listing.displayName),
  );

  return {
    ...listing,
    variants,
    suspected,
    documentsByRole: ROLE_ORDER.map((role) => ({
      role,
      hashes: [...filedUnder]
        .filter(([, played]) => played === role)
        .map(([hash]) => hash),
    })).filter((g) => g.hashes.length > 0),
  };
}

/**
 * The entities a command-line reference names: an entity id as the listing
 * prints it, or a spelling the Library has seen. A spelling can name two
 * entities — one Person and one Organization written the same way — which is
 * for the caller to report rather than guess between. A merged spelling names
 * the entity it was learned for, which is the one a Merge is taken back from.
 */
export function findEntities(lib: Library, ref: string): EntityRef[] {
  // The listing prints ids with a '#', so accept them written back that way.
  const asked = ref.replace(/^#/, "");
  if (/^\d+$/.test(asked)) {
    const found = entityById(lib, Number(asked));
    return found ? [found] : [];
  }
  const found: EntityRef[] = [];
  for (const kind of ["organization", "person"] as const) {
    const id = lib.naming.byName.get(nameKey(kind, asked));
    const ref = id === undefined ? null : entityById(lib, id);
    if (ref) found.push(ref);
  }
  return found;
}

/**
 * The entity with this id, or null when the id is nobody's — which is how a
 * caller tells an id that names nothing from one it names something it cannot
 * do, an Organization asked to be Me being the case in point.
 */
export function entityById(lib: Library, id: number): EntityRef | null {
  const e = lib.naming.entities.get(id);
  if (!e) return null;
  const merge = lib.naming.merges.find((m) => m.absorbedId === id);
  return {
    id: e.id,
    kind: e.kind,
    displayName: e.displayName,
    mergedInto: merge ? merge.survivorId : null,
  };
}

/**
 * Tell the Library that two names are the same Person, or the same
 * Organization. The name with the most Documents behind it survives — the
 * eighteen Documents filed under one spelling keep their heading, and the four
 * under another join them — unless the owner names the survivor themselves.
 *
 * Nothing is discarded and no Appearance is rewritten: afterwards the surviving
 * entity appears in the distinct Documents of both names, and `unmergeEntity`
 * puts things back exactly as they stood.
 */
export function mergeEntities(
  lib: Library,
  refA: number,
  refB: number,
  choice: MergeChoice = {},
): MergeOutcome {
  const a = requireEntity(lib, refA);
  const b = requireEntity(lib, refB);
  if (a.kind !== b.kind)
    throw new MergeRefused(
      `cannot merge ${aKind(a.kind)} with ${aKind(b.kind)}: ` +
        `#${a.id} ${a.displayName} is ${aKind(a.kind)}, ` +
        `#${b.id} ${b.displayName} is ${aKind(b.kind)}`,
    );

  const [survivor, absorbed] = survivorFirst(
    lib,
    survivorOf(lib, a.id),
    survivorOf(lib, b.id),
  );
  if (survivor.id === absorbed.id)
    throw new MergeRefused(
      `#${a.id} ${a.displayName} and #${b.id} ${b.displayName} are already the same ${a.kind}`,
    );

  const chosen = choice.displayName?.trim();
  const adopted = chosen ? nameToAdopt(lib, survivor, absorbed, chosen) : null;

  const merge: MergeRecord = {
    absorbedId: absorbed.id,
    survivorId: survivor.id,
    chosenName: chosen || null,
    replacedName: chosen ? survivor.displayName : null,
    adoptedName: adopted,
  };
  changeNaming(lib, (next) => {
    next.merges.push(merge);
    const surviving = entityIn(next, survivor.id);
    if (chosen) surviving.displayName = chosen;
    if (adopted) {
      surviving.variants.push(adopted);
      next.byName.set(nameKey(survivor.kind, adopted), survivor.id);
    }
  });

  return {
    survivor: {
      id: survivor.id,
      displayName: chosen || survivor.displayName,
      documents: countDocuments(lib, survivor.id),
    },
    absorbed: { id: absorbed.id, displayName: absorbed.displayName },
  };
}

/**
 * Take one Merge back: the named entity answers for itself again, with the
 * Documents that named its spelling — including any read while the two names
 * were one — and the surviving entity is left as it stood before. Merges made
 * into the named entity itself are not disturbed; they were not this Merge.
 */
export function unmergeEntity(
  lib: Library,
  absorbedId: number,
): UnmergeOutcome {
  const absorbed = requireEntity(lib, absorbedId);
  const merges = lib.naming.merges;
  const at = merges.findIndex((m) => m.absorbedId === absorbed.id);
  const merge = merges[at];
  if (!merge)
    throw new MergeRefused(
      `#${absorbed.id} ${absorbed.displayName} is not merged into another ${absorbed.kind}`,
    );

  const rederived = changeNaming(lib, (next) => {
    const forgot = takeBack(next, at);
    // A Document that named the spelling the Merge taught resolved through
    // it, and has to resolve again without it — as it would when the Library
    // is next opened, learning the spelling afresh where it is now unknown.
    return forgot ? deriveAll(next, lib.documents.values()).appearances : null;
  });
  if (rederived) replaceAppearances(lib, rederived);

  const survivor = requireEntity(lib, merge.survivorId);
  return {
    survivor: {
      id: survivor.id,
      displayName: survivor.displayName,
      documents: countDocuments(lib, survivor.id),
    },
    restored: {
      id: absorbed.id,
      displayName: absorbed.displayName,
      documents: countDocuments(lib, absorbed.id),
    },
  };
}

/**
 * Take the Merge at `at` out of `naming`. Says whether that forgot the
 * spelling the Merge taught.
 */
function takeBack(naming: Naming, at: number): boolean {
  const [merge] = naming.merges.splice(at, 1);
  if (!merge || merge.chosenName === null || merge.replacedName === null)
    return false;
  // Whether the name this Merge chose is still the one on show. When a later
  // Merge has renamed the entity again, that Merge owns the name now, so this
  // one hands its own name over for that Merge to put back instead of dropping
  // it: either way the oldest name is what the last Merge taken back restores.
  const surviving = entityIn(naming, merge.survivorId);
  let undone = surviving.displayName === merge.chosenName;
  if (undone) {
    surviving.displayName = merge.replacedName;
  } else {
    // The Merge that replaced this one's name takes on putting back the name
    // this one replaced. The most recent such Merge is the one holding it.
    const holder = naming.merges.findLast(
      (m) =>
        m.survivorId === merge.survivorId &&
        m.replacedName === merge.chosenName,
    );
    if (holder) holder.replacedName = merge.replacedName;
    undone = holder !== undefined;
  }
  // The spelling this Merge taught the survivor goes with the name, once no
  // Merge is relying on it any more.
  if (!undone || merge.adoptedName === null) return false;
  forgetSpelling(naming, surviving.kind, merge.adoptedName);
  return true;
}

/** Forget one spelling, from whichever entity holds it. */
function forgetSpelling(naming: Naming, kind: EntityKind, name: string): void {
  const key = nameKey(kind, name);
  const holder = naming.byName.get(key);
  if (holder === undefined) return;
  naming.byName.delete(key);
  const e = entityIn(naming, holder);
  e.variants = e.variants.filter((v) => nameKey(kind, v) !== key);
}

/**
 * Mark one of the People as Me, for one user: the reader's own post becomes
 * tellable from everyone else's, and the mark is made from that Person's page
 * so a name never has to be typed into configuration.
 *
 * A user has one Me, so marking a different Person replaces the mark rather
 * than adding a second one, and one user's mark says nothing about another's.
 * Only a Person can be Me — an institution is nobody's own paperwork — so an
 * id that names an Organization is `Refused` rather than quietly ignored, as is
 * one that names nobody. A caller that has to tell those two refusals apart
 * looks the id up with `entityById` first.
 *
 * Returns who answers for Me afterwards, which is what `markedAsMe` gives back.
 */
export function markMe(lib: Library, userId: string, entityId: number): number {
  const marked = requireEntity(lib, entityId);
  if (marked.kind !== "person")
    throw new Refused(
      `#${marked.id} ${marked.displayName} is ${aKind(marked.kind)}, ` +
        "and only a person can be me",
    );
  const user = lib.users.get(userId);
  if (!user) throw new Error(`no user with id: ${userId}`);
  updateUser(lib, {
    ...user,
    me: { entityId: marked.id, markedAt: new Date().toISOString() },
  });
  // Read back rather than worked out a second way, so what a mark answers and
  // what the lists are built from cannot come apart.
  return markedAsMe(lib, userId) ?? marked.id;
}

/**
 * The Person this user has marked as Me, or null when they have marked nobody.
 * Nobody is the answer for every user until they say otherwise, which is what
 * makes a second user's Me independent of the first's rather than inherited.
 *
 * A Merge made since the mark is followed, by the same walk every other read
 * uses: she is still Me under whichever name answers for her now, and taking
 * the Merge back leaves the mark on the name that was marked. A Merge that
 * somehow pointed in a circle leaves her unreachable, and the answer is nobody
 * rather than a name no listing has.
 */
export function markedAsMe(lib: Library, userId: string): number | null {
  const me = lib.users.get(userId)?.me;
  if (!me) return null;
  return answersFor(lib.naming).get(me.entityId) ?? null;
}

/** A kind as it reads in prose, article and all. */
const aKind = (kind: EntityKind) =>
  kind === "person" ? "a person" : "an organization";

/** The entity with this id, or a refusal naming the id that isn't one. */
function requireEntity(lib: Library, id: number): EntityRef {
  const found = entityById(lib, id);
  if (!found)
    throw new MergeRefused(`no person or organization with id: ${id}`);
  return found;
}

/**
 * The entity that answers for this one: itself, or whichever surviving name its
 * Merges lead to. Resolved by the same walk every read uses, so there is one
 * rule about what answers for what rather than two that can disagree.
 */
function survivorOf(lib: Library, entityId: number): EntityRef {
  const survivor = answersFor(lib.naming).get(entityId);
  const found = survivor === undefined ? null : entityById(lib, survivor);
  if (!found)
    // Unreachable from any surviving name: only a Merge pointing in a circle
    // does that, and the listing leaves those names out for the same reason.
    throw new Error(`no surviving name answers for #${entityId}`);
  return found;
}

/**
 * The two entities with the one that survives a Merge first: the one whose own
 * spelling has the most Documents behind it, and the one known longest when
 * they are level.
 *
 * It is the spelling's own Documents that decide, not the group's: the surviving
 * name is meant to be the most frequent variant, and a name with eight
 * Documents is the more frequent of the two even when the other has nine
 * between the spellings already merged under it. Deciding by what the Library
 * holds rather than by the order the owner typed is what makes merging a
 * statement that two names are the same, not a direction.
 */
function survivorFirst(
  lib: Library,
  a: EntityRef,
  b: EntityRef,
): [EntityRef, EntityRef] {
  if (a.id === b.id) return [a, b];
  const [countA, countB] = [ownDocuments(lib, a.id), ownDocuments(lib, b.id)];
  if (countA !== countB) return countA > countB ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/** The distinct Documents with an Appearance by one of these entities. */
function documentsNaming(lib: Library, ids: Set<number>): number {
  let count = 0;
  for (const appearances of lib.appearances.values())
    if (appearances.some((a) => ids.has(a.entityId))) count++;
  return count;
}

/**
 * The distinct Documents that named this spelling itself — what makes it the
 * more or less frequent variant — rather than those of the names merged into it.
 */
function ownDocuments(lib: Library, entityId: number): number {
  return documentsNaming(lib, new Set([entityId]));
}

/**
 * The distinct Documents an entity appears in, the names merged into it
 * included. A merged name counts the Documents of the group it answers to,
 * which is the count shown for it.
 */
function countDocuments(lib: Library, entityId: number): number {
  const answers = answersFor(lib.naming);
  const survivor = answers.get(entityId);
  if (survivor === undefined) return 0;
  const group = new Set(
    [...answers].filter(([, s]) => s === survivor).map(([id]) => id),
  );
  return documentsNaming(lib, group);
}

/**
 * The owner's chosen name as a spelling for the surviving entity to take in, or
 * null when one of the two names being merged already answers to it.
 *
 * A name the owner typed is a spelling the Person answers to, so a Document
 * that uses it later resolves to them rather than starting the work again. When
 * a third entity holds that spelling the Merge is refused: taking a name off
 * someone else would be a guess about them rather than a choice about these two.
 */
function nameToAdopt(
  lib: Library,
  survivor: EntityRef,
  absorbed: EntityRef,
  name: string,
): string | null {
  const holder = lib.naming.byName.get(nameKey(survivor.kind, name));
  const held =
    holder === undefined ? undefined : answersFor(lib.naming).get(holder);
  if (held === undefined) return name;
  if (held === survivor.id || held === absorbed.id) return null;
  throw new MergeRefused(
    `the name "${name}" is already #${held} ${entity(lib, held).displayName}`,
  );
}

/**
 * The pairs of listed entities whose names look like one name, for the owner to
 * confirm or ignore. Nothing is merged here, or anywhere else, without being
 * asked for: two people who share a surname must never be welded together
 * behind the owner's back, which is why this reports and does not decide.
 *
 * Suggestions stay within one kind — a Person and an Organization written the
 * same way are two different things — and are read off the entities a listing
 * already gives, so an entity whose Documents have all been Deleted is not
 * offered for merging.
 *
 * This is not a one-off cleanup. Names resolve when a Document is Enriched, so
 * every Import carrying an unseen spelling starts a new entity, and look-alikes
 * reappear as the Library grows.
 */
export function suggestDuplicates(
  entities: EntityListing[],
): DuplicateSuggestion[] {
  const suggestions: DuplicateSuggestion[] = [];
  for (const [index, one] of entities.entries())
    for (const other of entities.slice(index + 1))
      if (
        one.kind === other.kind &&
        looksLikeSameName(one.displayName, other.displayName)
      )
        suggestions.push({ kind: one.kind, entities: [one, other] });
  return suggestions;
}
