/**
 * How the Library's People and Organizations are arranged for browsing: the
 * Organization spine with its People nested beneath, the People who belong to no
 * Organization — headed by the reader themselves, where they have said which of
 * them that is — and the handful of entities the sidebar offers directly.
 *
 * Organizations form the spine because in a personal archive the institution is
 * almost always the sender, and institutions are what actually cluster — see
 * ADR-0001. A Person sits under every Organization they acted for, as one entity
 * with one count rather than a copy per Organization, because the affiliation
 * belongs to the Appearance and a Person may act for someone else in the next
 * Document.
 *
 * Like routes.ts and search.ts, this touches no database and no DOM: it takes
 * the entities the Library holds and decides only how they are shown, which is
 * what makes it testable without either.
 */

import { entityPath } from "./routes.ts";
import type { ApiBrowse, ApiEntity, EntityKind } from "./shared.ts";

/**
 * What browsing needs to know about one entity: the shape `listEntities`
 * returns, named structurally so this module stays free of the database the
 * entities came out of.
 */
export type Browsable = {
  id: number;
  kind: EntityKind;
  displayName: string;
  documents: number;
  /** For a Person, the Organizations they appeared for; empty for an Organization. */
  affiliations: { id: number; displayName: string }[];
};

/**
 * Two entities put to the owner as look-alikes, as browsing needs them. Which
 * names look alike is not browsing's business — it is a judgement about names,
 * made in the domain and handed in here — so this says only what a flagged pair
 * is, and nothing about how a pair comes to be one.
 */
export type SuspectedPair = {
  kind: EntityKind;
  entities: [Browsable, Browsable];
};

/**
 * The most shortcuts the sidebar will offer, so that navigation stays short and
 * links out to the full lists rather than turning into a tree of its own.
 */
export const SHORTCUT_LIMIT = 5;

/**
 * Every entity of one kind the browse lists show, in the order the lists have
 * them: the Organizations, or the People — the ones nested under an Organization
 * included, since a Person is one Person wherever she is listed.
 *
 * This is what a picker over "the entities of the same kind" is built from, and
 * it reads the lists rather than the Library so that what can be picked is
 * exactly what can be browsed: a name merged away is not listed, and so cannot
 * be merged a second time.
 */
export function listedEntities(
  browse: ApiBrowse,
  kind: EntityKind,
): ApiEntity[] {
  if (kind === "organization") return browse.organizations;
  // A Person who appeared for two Organizations has a row under each, and both
  // are the same Person: one entry per id, in the order first met.
  const people = new Map<number, ApiEntity>();
  for (const p of [
    ...browse.organizations.flatMap((o) => o.people),
    ...browse.people,
  ])
    if (!people.has(p.id)) people.set(p.id, p);
  return [...people.values()];
}

/** The wire shape of an entity, without whatever else the Library knows about it. */
const toApiEntity = (e: Browsable): ApiEntity => ({
  id: e.id,
  displayName: e.displayName,
  documents: e.documents,
});

/**
 * The order every browse list is in: the entities accounting for most of the
 * Library first, and alphabetically among equals so that a tie is broken by
 * something the reader can predict rather than by insertion order.
 */
const byPresence = (a: Browsable, b: Browsable) =>
  b.documents - a.documents ||
  a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: "base",
  });

/**
 * The Library's entities arranged for browsing, read from one listing so the two
 * lists and the sidebar cannot disagree about who the Library involves or how
 * many Documents they account for.
 *
 * Only entities that are passed in are listed, which is what keeps an entity
 * whose Documents have all been Deleted out of both lists: it is the listing
 * that drops it, and nothing here puts it back — the Person marked as Me
 * included, who is a row only while the Library still holds her paperwork. The
 * look-alike pairs are passed in for the same reason: they are read off that
 * same listing, so a pair can never name a row the lists do not have.
 *
 * `me` is the Person the reader has marked as themselves, or null when they
 * have marked nobody.
 */
export function browseView(
  entities: Browsable[],
  duplicates: SuspectedPair[] = [],
  me: number | null = null,
): ApiBrowse {
  const sorted = [...entities].sort(byPresence);
  const organizations = sorted.filter((e) => e.kind === "organization");
  const listable = new Set(organizations.map((o) => o.id));
  const people = sorted.filter((e) => e.kind === "person");

  /**
   * The Organizations a Person is shown under. Normally that is simply the ones
   * she is affiliated to: `deriveAppearances` takes an affiliation only from a
   * party whose Organization it also records an Appearance for, on the same
   * Document, so an affiliating Organization is itself always listed.
   *
   * The filter is a net under that invariant, which lives in another module. If
   * an affiliation is ever read from somewhere that does not also name the
   * Organization as a party, a Person affiliated only to an unlisted
   * Organization would have no row anywhere; here she falls back to the People
   * rather than vanishing from the Library's own account of who it involves.
   */
  const shownUnder = (p: Browsable) =>
    p.affiliations.filter((a) => listable.has(a.id));

  /**
   * The reader themselves, when the Library still holds a Document naming them.
   * They head the People whatever Organization they appeared for: "addressed to
   * me" apart from "addressed to someone else here" is the distinction the mark
   * exists for, and it is not browsable if the reader's own row is filed under
   * an institution they once wrote to. They keep that row too — a Person
   * appears under every Organization they acted for — so this is the same
   * entity shown in another place, as the lists already do elsewhere.
   */
  const reader = people.find((p) => p.id === me);

  return {
    organizations: organizations.map((o) => ({
      ...toApiEntity(o),
      people: people
        .filter((p) => shownUnder(p).some((a) => a.id === o.id))
        .map(toApiEntity),
    })),
    people: [
      ...(reader ? [reader] : []),
      ...people.filter((p) => p.id !== me && shownUnder(p).length === 0),
    ].map(toApiEntity),
    shortcuts: sorted
      .filter((e) => e.documents > 0)
      .slice(0, SHORTCUT_LIMIT)
      .map((e) => ({
        ...toApiEntity(e),
        // The entity's own page, which is what the owner wanted when they
        // reached for the shortcut: the Person or Organization itself, not the
        // list it is a row of. The address comes from routes.ts rather than being
        // written out here, so the one place that decides where an entity's
        // page lives is the one place both ends read.
        path: entityPath(e.kind, e.id),
      })),
    duplicates: duplicates.map(({ kind, entities: [one, other] }) => ({
      kind,
      entities: [toApiEntity(one), toApiEntity(other)],
    })),
    me,
  };
}
