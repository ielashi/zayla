/**
 * What the gallery shows for a search, in display order: the Documents the
 * server found, or the whole Library when there is no query.
 *
 * Matching happens on the server, over everything Zayla worked out about a
 * Document, Transcription included (see core/search.ts); what this module
 * decides is the order the result is shown in, and how the sort follows the
 * search box.
 *
 * Search is no longer the only way in. Browsing by Person and Organization sits
 * alongside it — see ADR-0001 — which is also why browsing by type, by keyword
 * and by folder are still absent: they were rejected, not merely unbuilt.
 * Searching reads the whole Library, whichever section is being viewed.
 *
 * Nothing here touches the DOM or the network, which is what makes it testable.
 */
import type { ApiDocument, ApiSearchHit } from "./shared.ts";

/**
 * How results are ordered. "best" is Best match, the server's order: it is
 * offered only while there is a query, and falls back to "new" without one.
 */
export type SortKey = "best" | "new" | "old" | "added" | "name" | "size";

export type SearchOptions = {
  /** The server's answer for the current query, in Best match order; null with no query. */
  hits: ApiSearchHit[] | null;
  sort: SortKey;
  /**
   * Hashes added during this session, newest first. With no query they pin to
   * the top ahead of the sort, so a just-dropped (still undated, still
   * enriching) Document doesn't sink out of sight under "Newest". During a
   * search they don't: a Document shows there because it matched.
   */
  recent?: string[];
};

/** What a Document is called on screen: its enriched title until it has one. */
export const titleOf = (d: ApiDocument): string => d.title || d.filename;

const isEmpty = (query: string) => query.trim() === "";

/**
 * The sort to use once the search box goes from `before` to `after`. Starting a
 * search switches to Best match, since that is when it matters which result is
 * the one meant; clearing the box returns to Newest. In between, whatever sort
 * is in force holds — including one chosen by hand during the search.
 */
export function sortAfterTyping(
  before: string,
  after: string,
  sort: SortKey,
): SortKey {
  if (isEmpty(before) && !isEmpty(after)) return "best";
  if (!isEmpty(before) && isEmpty(after)) return "new";
  return sort;
}

/**
 * "Newest"/"Oldest" rank by the Document's own date. Documents without one (not
 * yet enriched, or whose date couldn't be read) sink to the bottom regardless of
 * direction — an unknown date is not an old one.
 */
function byDocDate(a: ApiDocument, b: ApiDocument, newestFirst: boolean) {
  if (!a.date && !b.date) return 0;
  if (!a.date) return 1;
  if (!b.date) return -1;
  return newestFirst
    ? b.date.localeCompare(a.date)
    : a.date.localeCompare(b.date);
}

function compare(a: ApiDocument, b: ApiDocument, sort: SortKey) {
  switch (sort) {
    case "old":
      return byDocDate(a, b, false);
    case "added":
      return b.addedAt.localeCompare(a.addedAt);
    case "name":
      return titleOf(a).localeCompare(titleOf(b));
    case "size":
      return b.bytes - a.bytes;
    default:
      return byDocDate(a, b, true);
  }
}

/** The Documents a search shows, in display order. The input is left alone. */
export function searchDocuments(
  docs: ApiDocument[],
  { hits, sort, recent = [] }: SearchOptions,
): ApiDocument[] {
  if (hits) {
    const byHash = new Map(docs.map((d) => [d.hash, d]));
    const found = hits.flatMap((h) => byHash.get(h.hash) ?? []);
    return sort === "best" ? found : found.sort((a, b) => compare(a, b, sort));
  }
  const pinned = (d: ApiDocument) => {
    const i = recent.indexOf(d.hash);
    return i === -1 ? Infinity : i;
  };
  return [...docs].sort((a, b) => {
    const ra = pinned(a);
    const rb = pinned(b);
    return ra !== rb ? ra - rb : compare(a, b, sort);
  });
}
