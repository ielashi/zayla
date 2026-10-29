/**
 * What crosses the frontend↔backend wire boundary: the types both ends read.
 *
 * This module is deliberately dependency-free (no Bun, no DOM, no other project
 * imports) so the browser build and the server can both import it, and so the
 * frontend's DOM-flavoured typecheck never drags in server-only code. The
 * vocabulary of the domain that both ends need — what kind of thing a name
 * names, and the part it played — is therefore declared here and read from here
 * by the domain modules too, as `Party` already is.
 */

/** "needs_ocr" is legacy: pre-vision rows flagged for a pass that listPending now picks up. */
export type DocumentStatus = "imported" | "enriched" | "needs_ocr";

/** A party to the document. organization is primary; person is "" when not named. */
export type Party = { organization: string; person: string };

/** A date by which some action is required (payment due, appeal period, appointment…). */
export type Deadline = { label: string; date: string };

/**
 * The record the gallery consumes: catalog fields plus extracted metadata
 * (null until enriched). `ref` is flattened to [key, value] pairs for the UI.
 * Produced by `toApi` in serve.ts; consumed by frontend.ts.
 */
export type ApiDocument = {
  hash: string;
  filename: string;
  mime: string;
  ext: string;
  bytes: number;
  addedAt: string;
  status: DocumentStatus;
  title: string | null;
  people: string[];
  date: string | null;
  languages: string[];
  keywords: string[];
  summary: string | null;
  ref: [string, string][];
  sender: Party | null;
  receiver: Party | null;
  deadlines: Deadline[];
  /**
   * How many pages the Original has, each served by
   * `/api/documents/:hash/pages/:n`: one for an image, null when it isn't
   * known — a type with no pages, or a PDF poppler couldn't read.
   */
  pages: number | null;
};

/**
 * Where a search term was found in a Document, best first: 1 on the card
 * (title, sender, receiver), 2 elsewhere in the reading, 3 only in the
 * Transcription. An order, which is why it is a number.
 */
export type SearchTier = 1 | 2 | 3;

/** A passage of a Transcription, with the query's terms marked as [from, to) offsets into `text`. */
export type Snippet = { text: string; marks: [number, number][] };

/**
 * One Document a search found, in Best match order. Produced by
 * `/api/search`; the Document itself is the one the gallery already holds.
 */
export type ApiSearchHit = {
  hash: string;
  /** Where its weakest term was found. */
  tier: SearchTier;
  /**
   * For a Document found only through its Transcription (tier 3), the passage
   * that matched; null otherwise, since what matched is already on the card.
   */
  snippet: Snippet | null;
};

/** What kind of thing a name names. */
export type EntityKind = "person" | "organization";

/** The part a name played in a Document. */
export type AppearanceRole = "sender" | "receiver" | "mentioned";

/**
 * One Person or Organization as a browse list carries it: what it is called, and
 * how much of the Library it accounts for. The kind is not on the wire because
 * the lists say it — an Organization by being in `organizations`, a Person by
 * sitting under one or in `people`.
 */
export type ApiEntity = {
  id: number;
  displayName: string;
  /** Distinct Documents this entity appears in, counted once per Document. */
  documents: number;
};

/**
 * An entity where only which one it is and what it is called matter: a name the
 * owner can act on — merge into, take a Merge back from — without the Library
 * having to say anything else about it.
 */
export type ApiNamedEntity = { id: number; displayName: string };

/**
 * Two listed entities of one kind whose names look like they belong to one
 * Person or one Organization. A suggestion is a question put to the owner:
 * nothing has been merged, and nothing will be until they say so.
 */
export type ApiDuplicate = {
  kind: EntityKind;
  /** The pair, the entity with more Documents first, as the lists have them. */
  entities: [ApiEntity, ApiEntity];
};

/** An Organization, with the People who appeared for it. */
export type ApiOrganization = ApiEntity & { people: ApiEntity[] };

/** A sidebar shortcut: an entity, and the address of its page. */
export type ApiShortcut = ApiEntity & { path: string };

/**
 * Everything the browse lists and the sidebar shortcuts need, read from the
 * Library once. Organizations are the spine; `people` holds only those belonging
 * to no Organization, who would otherwise have nowhere to be listed.
 */
export type ApiBrowse = {
  organizations: ApiOrganization[];
  people: ApiEntity[];
  shortcuts: ApiShortcut[];
  /**
   * The pairs of listed names that look like one name, so the lists can flag
   * them where the owner is already reading. Confirming one is the business of
   * the entity's own page, which is where the owner sees what they would be
   * merging.
   */
  duplicates: ApiDuplicate[];
  /**
   * The Person the reader has marked as Me, by id, or null when they have
   * marked nobody. One id rather than a flag on a row: Me is a fact about the
   * reader, and the same Person is Me wherever they are listed.
   */
  me: number | null;
};

/**
 * The Documents an entity appears in under one part it played, by hash. Hashes
 * rather than records: the gallery already holds the Library's Documents, so an
 * entity's page draws the same cards from the same source, and a Document that
 * is re-Enriched while the page is open has one copy to update rather than two.
 */
export type ApiRoleGroup = { role: AppearanceRole; hashes: string[] };

/**
 * One Person or Organization as its own page shows it: what the browse lists
 * say about it, every spelling it has been written as — which is how a Merge is
 * checked rather than taken on trust — and its Documents grouped by the part it
 * played.
 *
 * Unlike a browse list, the page carries the kind: the address says it, but the
 * page is read from the data rather than from where it sits.
 */
export type ApiEntityPage = ApiEntity & {
  kind: EntityKind;
  /** Every spelling this entity has been written as, the merged names' included. */
  variants: string[];
  /** For a Person, the Organizations they appeared for; empty for an Organization. */
  affiliations: ApiNamedEntity[];
  /**
   * The names merged into this one, which it now answers to as well. Named
   * rather than merely spelled out among the variants, because each is a Merge
   * the owner can take back from this page.
   */
  mergedNames: ApiNamedEntity[];
  /**
   * The listed entities of this kind whose names look like this one's, offered
   * for the owner to confirm or leave alone. Nothing here has been merged.
   */
  suspected: ApiEntity[];
  /**
   * The Documents, in sender/receiver/mentioned order, each Document under the
   * most prominent part the entity played in it and so in exactly one group.
   * A part the entity never played is absent rather than empty.
   */
  roles: ApiRoleGroup[];
};

/**
 * What a Merge did: the name that survived it, with the Documents it now covers,
 * and the name it took in. The surviving name is the Library's to decide — the
 * most frequent variant unless the owner chose one — so the answer says which
 * it was rather than leaving the browser to assume.
 */
export type ApiMergeOutcome = {
  survivor: ApiEntity;
  absorbed: ApiNamedEntity;
};

/** What taking a Merge back did: the two names it leaves behind, with their counts. */
export type ApiUnmergeOutcome = {
  survivor: ApiEntity;
  restored: ApiEntity;
};

/**
 * The Library's Provider as Settings shows it. The key itself never crosses
 * the wire: the browser is told only whether one is held.
 */
/** OpenRouter, at its one address, or Custom, at the address the user gave. */
export type ProviderKind = "openrouter" | "custom";

export type ApiProvider = {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Zero retention; always false for a Custom Provider, which has none to offer. */
  zeroRetention: boolean;
  chosenAt: string;
};
