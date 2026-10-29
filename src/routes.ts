/**
 * Where the Library can be reached from: the destinations the sidebar offers,
 * the pages of the entities below them, the paths that address all of those, and
 * the mapping from a path back to one.
 *
 * The paths are enumerated here rather than matched by a catch-all, and this one
 * list is what both ends read: the server registers exactly these paths, and the
 * browser resolves the address bar against them. That is what makes an
 * unrecognized address answer as not found instead of quietly rendering the
 * application shell — the two ends cannot disagree about what exists.
 *
 * An entity's page is the one address that cannot be settled here: whether
 * `/people/12` exists depends on whether the Library holds that Person, which is
 * a question for the server. What this module decides is the shape of such an
 * address and which entity it names; see serve.ts for the answer to the rest.
 *
 * Nothing here touches the DOM or the network, which is what makes it testable.
 */

import type { EntityKind } from "./shared.ts";

/** A destination the sidebar offers, and the path that reaches it. */
export type Destination = {
  name: "documents" | "organizations" | "people";
  path: string;
  label: string;
};

/** The destinations an entity's page can sit below: the ones that list entities. */
export type EntityDestination = Exclude<Destination["name"], "documents">;

/** What an address resolved to: a destination, one entity's page, or nothing. */
export type Route =
  | { at: Destination["name"] }
  | { at: "entity"; kind: EntityKind; id: number }
  | { at: "not-found" };

/**
 * The sidebar's destinations, in the order they are shown. Documents sits at the
 * root because it is what the Library opens on.
 */
export const DESTINATIONS: readonly Destination[] = [
  { name: "documents", path: "/", label: "Documents" },
  { name: "organizations", path: "/organizations", label: "Organizations" },
  { name: "people", path: "/people", label: "People" },
] as const;

/** The paths the server registers, so no destination is reachable only client-side. */
export const DESTINATION_PATHS: readonly string[] = DESTINATIONS.map(
  (d) => d.path,
);

/**
 * The destination an entity's page sits below, by kind: an Organization's page
 * under the Organizations, a Person's under the People. One correspondence, so
 * the address a link is built from and the address the server registers cannot
 * disagree about where an entity's page lives.
 */
const LISTED_UNDER: Record<EntityKind, EntityDestination> = {
  organization: "organizations",
  person: "people",
};

/** The destination an entity of this kind is listed under. */
export const listedUnder = (kind: EntityKind): EntityDestination =>
  LISTED_UNDER[kind];

/** The destination a name refers to. */
export function destination(name: Destination["name"]): Destination {
  const found = DESTINATIONS.find((d) => d.name === name);
  if (!found) throw new Error(`no destination named ${name}`);
  return found;
}

/** The address of one entity's page. */
export const entityPath = (kind: EntityKind, id: number): string =>
  `${destination(LISTED_UNDER[kind]).path}/${id}`;

/**
 * The patterns the server registers for entity pages, one per kind. They are
 * patterns rather than paths because which ids exist is the Library's business
 * and changes as Documents are read; the handler behind them decides.
 */
export const ENTITY_PATH_PATTERNS: readonly string[] = Object.values(
  LISTED_UNDER,
).map((name) => `${destination(name).path}/:id`);

/**
 * The entity a path segment names, or null when it names none. Digits only, with
 * no leading zero and no sign, so one entity has exactly one address: `/people/7`
 * is a Person's page and `/people/007` is nothing at all.
 */
export function entityId(segment: string): number | null {
  return /^[1-9][0-9]*$/.test(segment) ? Number(segment) : null;
}

/**
 * Which destination or entity page an address names, or `not-found`. Matching is
 * exact — so case-sensitive, as addresses are, and a trailing slash is a
 * different address — which is how a mistyped path, including a mistyped data
 * path, resolves to nothing rather than to the nearest destination.
 */
export function resolveRoute(pathname: string): Route {
  const found = DESTINATIONS.find((d) => d.path === pathname);
  if (found) return { at: found.name };

  for (const [kind, name] of Object.entries(LISTED_UNDER) as [
    EntityKind,
    EntityDestination,
  ][]) {
    const under = `${destination(name).path}/`;
    if (!pathname.startsWith(under)) continue;
    const id = entityId(pathname.slice(under.length));
    if (id !== null) return { at: "entity", kind, id };
  }
  return { at: "not-found" };
}
