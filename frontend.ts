import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { listedEntities } from "./src/browse.ts";
import { tabFor, wrapFocus } from "./src/focus.ts";
import { type Html, type HtmlValue, html, join, setHtml } from "./src/html.ts";
import {
  languageName,
  OFFERED_LANGUAGES,
  TESTED_LANGUAGES,
} from "./src/languages.ts";
import {
  DESTINATIONS,
  type Destination,
  entityPath,
  listedUnder,
  type Route,
  resolveRoute,
} from "./src/routes.ts";
import {
  type SortKey,
  searchDocuments,
  sortAfterTyping,
  titleOf,
} from "./src/search.ts";
import type {
  ApiBrowse,
  ApiDocument,
  ApiEntity,
  ApiEntityPage,
  ApiMergeOutcome,
  ApiProvider,
  ApiSearchHit,
  ApiUnmergeOutcome,
  AppearanceRole,
  EntityKind,
  Party,
  ProviderKind,
} from "./src/shared.ts";

/** Fetch a required static element by id, asserting it exists. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const view = el("view");
const nav = el("nav");
const tabs = el("tabs");
const shortcuts = el("shortcuts");

/**
 * One entity's page as far as it has been read: which entity the address names,
 * what the Library said about it, and whether the Library no longer has it —
 * which only a page reached from a list that has since gone stale can be.
 */
type EntityState = {
  id: number;
  page: ApiEntityPage | null;
  gone: boolean;
};

type State = {
  /** What the address bar names. Kept in step with it by `show`. */
  route: Route;
  docs: ApiDocument[];
  /** Who the Documents involve, as the browse lists and shortcuts need them. */
  browse: ApiBrowse | null;
  /** The entity whose page is showing, or null anywhere else. */
  entity: EntityState | null;
  q: string;
  /**
   * The server's answer for the last query it answered, in Best match order;
   * null with no query. While a newer query is on its way this still holds the
   * last answer, so the results stay on screen instead of flashing empty.
   */
  hits: ApiSearchHit[] | null;
  sort: SortKey;
  loaded: boolean;
  // enriching/errored: hashes with an in-flight or failed enrich pass.
  enriching: Set<string>;
  errored: Set<string>;
  // recent: hashes added this session, newest first — pinned to the top of the
  // grid so a just-dropped (still undated) doc doesn't sink under "Newest".
  recent: string[];
  /** The Library's Provider; while there is none, Documents wait to be read. */
  provider: ApiProvider | null;
  /** Hashes queued to be sent to the Provider, one at a time, by `sendToProvider`. */
  queued: Set<string>;
};

/**
 * What the address names. The server serves the shell only at a destination's
 * path or at the address of an entity it holds, so this always finds one. If
 * that ever stops holding, say so loudly rather than guess at a view — the
 * not-found answer belongs to the server, which has a page for it.
 */
function addressedRoute(): Route {
  const route = resolveRoute(location.pathname);
  if (route.at === "not-found")
    throw new Error(`the application shell was served at ${location.pathname}`);
  return route;
}

const state: State = {
  route: addressedRoute(),
  docs: [],
  browse: null,
  entity: null,
  q: "",
  hits: null,
  sort: "new",
  loaded: false,
  enriching: new Set(),
  errored: new Set(),
  recent: [],
  provider: null,
  queued: new Set(),
};

// Compact party label for cards: organization if present, else the person.
const partyLabel = (p: Party | null) =>
  p ? p.organization || p.person || "" : "";

const fmtSize = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const kind = (d: ApiDocument) =>
  (d.ext || (d.mime.split("/")[1] ?? "")).toUpperCase() || "FILE";
function unreachable() {
  setHtml(
    view,
    html`<div class="state"><h2>Couldn't reach the library</h2><p>Is the server running?</p></div>`,
  );
}

/**
 * Read the Library: the Documents, who they involve, and the Provider that
 * reads them. They are fetched together because the sidebar shows facts from
 * the first two whichever destination is being viewed, and whether a Document
 * is waiting to be read depends on the third.
 */
async function load() {
  let docs: Response;
  let entities: Response;
  let provider: Response;
  try {
    [docs, entities, provider] = await Promise.all([
      fetch("/api/documents"),
      fetch("/api/entities"),
      fetch("/api/provider"),
    ]);
  } catch {
    unreachable();
    return;
  }
  // Session expired (or lost) mid-use: fall back to the login gate.
  if (
    docs.status === 401 ||
    entities.status === 401 ||
    provider.status === 401
  ) {
    refreshAuth();
    return;
  }
  if (!docs.ok || !entities.ok || !provider.ok) {
    unreachable();
    return;
  }
  state.docs = (await docs.json()) as ApiDocument[];
  state.browse = (await entities.json()) as ApiBrowse;
  state.provider = (
    (await provider.json()) as { provider: ApiProvider | null }
  ).provider;
  state.loaded = true;
  renderNav(); // the shortcuts arrive with the data
  render();
  if (state.route.at === "entity") loadEntity(state.route.id);
}

/**
 * Read one entity's page: what the Library says about it, and which of its
 * Documents it appears in under each part it played. Read per address rather
 * than with the Library, because it is one entity's paperwork rather than a fact
 * the sidebar needs — and re-read when an Enrichment changes who is involved.
 *
 * The Documents themselves are not re-read: the page names them by hash and the
 * cards come from the gallery's own copy, so a Document reads the same here as
 * it does everywhere else.
 */
async function loadEntity(id: number) {
  // A re-read keeps showing what it had until the new answer arrives, so an
  // Enrichment finishing does not blank the page the reader is looking at.
  if (state.entity?.id !== id) state.entity = { id, page: null, gone: false };
  let res: Response;
  try {
    res = await fetch(`/api/entities/${id}`);
  } catch {
    unreachable();
    return;
  }
  if (res.status === 401) {
    refreshAuth();
    return;
  }
  // The Library held this entity when the list showing it was drawn and no
  // longer does — its last Document was Deleted since. The address itself is
  // the server's to answer, and it would have said so on a reload.
  const page = res.ok ? ((await res.json()) as ApiEntityPage) : null;
  if (!page && res.status !== 404) {
    unreachable();
    return;
  }
  // Another address won the race while this one was being read.
  if (state.entity?.id !== id) return;
  state.entity = { id, page, gone: page === null };
  renderNav();
  render();
}

/**
 * Re-read who the Documents involve. Appearances are recorded when a Document is
 * Enriched, so the lists and the shortcuts change at exactly that moment and at
 * no other — which is why this is called on a finished Enrichment rather than
 * polled. A failed re-read leaves the lists showing what they had: a stale count
 * is better than emptying a list the Library still holds.
 */
async function reloadBrowse() {
  try {
    const res = await fetch("/api/entities");
    if (!res.ok) return;
    state.browse = (await res.json()) as ApiBrowse;
  } catch {
    return;
  }
  renderNav();
  render();
  // The entity whose page is open has just as likely gained a Document.
  if (state.route.at === "entity") await loadEntity(state.route.id);
}

// Search is no longer the only way into the Library — browsing by Person and
// Organization sits alongside it, see ADR-0001 — but it still reads the whole
// Library rather than the destination being viewed. The matching happens on the
// server, and the ordering in src/search.ts, away from the DOM, so both can be
// tested directly.
const visible = (): ApiDocument[] =>
  searchDocuments(state.docs, {
    hits: state.hits,
    sort: state.sort,
    recent: state.recent,
  });

/** The server's hit for a Document in the current search, if it is one. */
const hitFor = (hash: string): ApiSearchHit | undefined =>
  state.hits?.find((h) => h.hash === hash);

/** How long typing has to pause before the query goes to the server. */
const SEARCH_PAUSE_MS = 150;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Counts queries sent, so an answer that a newer query overtook is dropped. */
let searchSeq = 0;

/**
 * Ask the server what the current query finds, and show it. Called after a
 * pause in typing, and straight away when the Library changes under a search.
 * An answer arriving after a newer query was sent is dropped, so a slow answer
 * for "ta" never replaces the one for "tax".
 */
async function runSearch() {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const q = state.q.trim();
  if (!q) {
    state.hits = null;
    render();
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = (await res.json()) as ApiSearchHit[];
    if (seq !== searchSeq) return;
    state.hits = hits;
    render();
  } catch (err) {
    if (seq === searchSeq)
      toast(`Search failed: ${(err as Error).message}`, true);
  }
}

/** Re-ask the current search, when what the Library holds has changed under it. */
const refreshSearch = () => {
  if (state.q.trim()) void runSearch();
};

/**
 * Keep the sort control in step with the sort in force. Best match is offered
 * only while there is a query to be a match for.
 */
function syncSortControl() {
  const select = el<HTMLSelectElement>("sort");
  const best = select.querySelector<HTMLOptionElement>('option[value="best"]');
  if (state.q.trim() && !best) select.prepend(new Option("Best match", "best"));
  else if (!state.q.trim() && best) best.remove();
  select.value = state.sort;
}

// ---- navigation -----------------------------------------------------------

/**
 * The destination the address sits in: the one it names, or — on an entity's
 * page — the list that holds the entity, since that is the section being
 * browsed even though the page is a step below it.
 */
function section(): Destination["name"] | null {
  if (state.route.at === "entity") return listedUnder(state.route.kind);
  return state.route.at === "not-found" ? null : state.route.at;
}

/** Each destination's mark in a phone's tab bar, beside its label. */
const TAB_ICONS: Record<Destination["name"], Html> = {
  documents: html`<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>`,
  organizations: html`<path d="M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16M15 9h4a1 1 0 011 1v11M3 21h18"/><path d="M8 8h3M8 12h3M8 16h3"/>`,
  people: html`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.5a3.5 3.5 0 010 7M18 14.5a6.5 6.5 0 013.5 5.5"/>`,
};

/**
 * The destinations, built from the list the server registers: in the sidebar
 * on a desktop and in the tab bar on a phone, which CSS chooses between.
 */
function renderNav() {
  const links = (icons: boolean) =>
    DESTINATIONS.map((d) => {
      const a = document.createElement("a");
      a.href = d.path;
      setHtml(
        a,
        html`${icons && html`<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${TAB_ICONS[d.name]}</svg>`}${d.label}`,
      );
      // "page" for the destination itself; "true" for the one an entity's page
      // is below, which is where the reader is without being what they are on.
      if (section() === d.name)
        a.setAttribute(
          "aria-current",
          state.route.at === "entity" ? "true" : "page",
        );
      return a;
    });
  nav.replaceChildren(...links(false));
  tabs.replaceChildren(...links(true));
  renderShortcuts();
}

/**
 * The handful of entities the Library's Documents involve most, offered directly
 * in the sidebar. Which ones they are is the server's judgement — the entities
 * with the most Documents behind them, capped so the sidebar stays short — and
 * each carries the address of that entity's own page.
 */
function renderShortcuts() {
  const offered = state.browse?.shortcuts ?? [];
  shortcuts.hidden = offered.length === 0;
  if (!offered.length) {
    shortcuts.replaceChildren();
    return;
  }
  const heading = document.createElement("h2");
  heading.id = "shortcuts-head"; // what names this nav — see index.html
  heading.textContent = "Most documents";
  shortcuts.replaceChildren(
    heading,
    ...offered.map((s) => {
      const a = document.createElement("a");
      a.href = s.path;
      if (s.path === location.pathname) a.setAttribute("aria-current", "page");
      setHtml(
        a,
        html`<span class="sc-name">${s.displayName}</span>${countLabel(s.documents)}`,
      );
      return a;
    }),
  );
}

/**
 * Draw whatever the address bar names. The address is the one truth about which
 * destination is showing, which is what makes back, forward, a reload and a
 * bookmarked address all agree.
 */
function show() {
  state.route = addressedRoute();
  // An entity's page is read per address; every other view is already in hand.
  if (state.route.at !== "entity") state.entity = null;
  else if (state.entity?.id !== state.route.id) loadEntity(state.route.id);
  renderNav();
  render();
}

/** Move to a path: the address changes first, then the view follows from it. */
function navigate(path: string) {
  if (path !== location.pathname) history.pushState(null, "", path);
  show();
}

window.addEventListener("popstate", show);

// Internal links move between destinations and entity pages in place. Anything
// else is left to the browser: a new-tab or modified click, a download, another
// origin, or a path routing doesn't recognize — which is how the original file's
// own address stays an ordinary link.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (!(e.target instanceof Element)) return;
  const link = e.target.closest<HTMLAnchorElement>("a");
  if (!link || link.target || link.hasAttribute("download")) return;
  if (link.origin !== location.origin) return;
  if (resolveRoute(link.pathname).at === "not-found") return;
  e.preventDefault();
  navigate(link.pathname);
});

// ---- rendering ------------------------------------------------------------

function render() {
  const list = visible();
  // The count is a fact about the whole Library, so the sidebar shows it
  // whichever destination is being viewed — as does the search it reflects. A
  // phone has no sidebar, and shows it above the Documents alone.
  const count = state.docs.length
    ? `${list.length}${list.length !== state.docs.length ? ` of ${state.docs.length}` : ""} ${documentWord(state.docs.length)}`
    : "";
  el("count").textContent = count;
  el("view-count").textContent = count;
  // Sorting orders the Document view alone: the lists and an entity's page
  // keep an order of their own, so elsewhere the control would do nothing.
  el("sort").hidden = state.route.at !== "documents";
  el("view-tools").hidden = state.route.at !== "documents";

  switch (state.route.at) {
    case "organizations":
      return renderOrganizations();
    case "people":
      return renderPeople();
    case "entity":
      return renderEntity(state.route.id);
    case "documents":
      return renderDocuments(list);
    case "not-found":
      // Unreachable: the shell is only served where something is.
      return unreachable();
  }
}

// ---- browsing by Person and Organization ----------------------------------

/** The word for a number of Documents, in one place rather than three. */
const documentWord = (documents: number) =>
  documents === 1 ? "document" : "documents";

/** One entity's Document count: a number to scan, and the word for a reader. */
function countLabel(documents: number): Html {
  return html`<span class="ent-count">${documents}<span class="sr-only"> ${documentWord(documents)}</span></span>`;
}

/**
 * The listed names this entity has been flagged as possibly being, which is a
 * question and not a finding: the Library suggests, the owner decides. Read
 * from the lists' own pairs, so a row is flagged in the lists for exactly the
 * reason its page offers.
 */
const looksLike = (id: number): string[] =>
  (state.browse?.duplicates ?? []).flatMap(({ entities: [one, other] }) =>
    one.id === id
      ? [other.displayName]
      : other.id === id
        ? [one.displayName]
        : [],
  );

/**
 * How the Person the reader has marked as Me is labelled, wherever they are
 * shown: the one row in the lists that is the reader's own paperwork rather
 * than someone else's.
 */
const ME_TAG = html`<span class="me-tag">Me</span>`;

/** Whether this entity is the Person the reader has marked as themselves. */
const isMe = (id: number) => state.browse?.me === id;

/**
 * One row of a browse list: a link to that entity's own page, which is what the
 * lists are for. A Person listed under two Organizations has a row under each,
 * and both lead to her one page.
 *
 * A row whose name looks like another's says so where the owner is already
 * reading, and leads to the page where the question can be answered — nothing
 * is merged from a list, because a list does not show what would be merged.
 */
function entityRow(e: ApiEntity, kind: EntityKind): Html {
  const alike = looksLike(e.id);
  const flag =
    alike.length > 0 &&
    html`<span class="ent-alike" title="Possibly the same as ${alike.join(", ")}">Possible duplicate</span>`;
  // Whose paperwork the row is comes before any question about its name: the
  // reader knows which row is theirs at a glance, and the question stays next
  // to the count it is about.
  return html`<a class="ent" href="${entityPath(kind, e.id)}"><span class="ent-name">${e.displayName}</span>${isMe(e.id) && ME_TAG}${flag}${countLabel(e.documents)}</a>`;
}

/** The panel for a destination whose list is empty, with the reason it is. */
function renderNothing(heading: string, why: string) {
  setHtml(
    view,
    html`<div class="state"><h2>${heading}</h2><p>${why}</p></div>`,
  );
}

/**
 * Nothing is known yet about who the Library involves. Said once for both
 * destinations, because the reason is the same and it is not that the owner has
 * no People or no Organizations: it is that no Document has been read yet.
 */
const nobodyYet = () =>
  !state.browse?.organizations.length && !state.browse?.people.length;

/** Why both lists are empty, in one place so the two cannot drift apart. */
const NOBODY_YET = [
  "Nobody yet",
  "Processing a document records who it involves. Add some documents and the people and organizations they name will be listed here.",
] as const;

function renderOrganizations() {
  const browse = state.browse;
  // The gate only lifts once the Library has been read, so arriving here with
  // nothing read means the read failed. Say so rather than show an empty list,
  // which would read as "you have none of these".
  if (!browse) return unreachable();
  if (nobodyYet()) return renderNothing(...NOBODY_YET);
  if (!browse.organizations.length)
    return renderNothing(
      "No organizations yet",
      "Every name your documents carry so far is a person's — they are under People.",
    );

  // One column of sections divided like a list, each headed by its
  // Organization so that a reader can move between them by heading, with the
  // People who acted for it beneath.
  setHtml(
    view,
    html`<div class="entities">${browse.organizations.map(
      (o) => html`<section class="org">
        <h2 class="org-head">${entityRow(o, "organization")}</h2>
        ${
          o.people.length > 0 &&
          html`<ul class="under">${o.people.map((p) => html`<li>${entityRow(p, "person")}</li>`)}</ul>`
        }
      </section>`,
    )}</div>`,
  );
}

function renderPeople() {
  const browse = state.browse;
  if (!browse) return unreachable();
  if (nobodyYet()) return renderNothing(...NOBODY_YET);
  if (!browse.people.length)
    return renderNothing(
      "Nobody outside an organization",
      "Everyone your documents name appeared for an institution, so they are listed under Organizations.",
    );

  setHtml(
    view,
    html`<ul class="entities">${browse.people.map(
      (p) => html`<li>${entityRow(p, "person")}</li>`,
    )}</ul>`,
  );
}

/**
 * A Document filed but not yet read, and neither queued, being read nor failed:
 * it waits, for a Provider to be chosen or for the owner to send it. Not a
 * failure.
 */
const isWaiting = (d: ApiDocument) =>
  d.status !== "enriched" &&
  !state.queued.has(d.hash) &&
  !state.enriching.has(d.hash) &&
  !state.errored.has(d.hash);

/**
 * One Document's card, wherever Documents are shown: the gallery and an entity's
 * page draw the same card from the same record, so a Document is recognized by
 * its thumbnail in one place exactly as in the other — and a failed Enrichment
 * offers its retry on both, as a waiting one offers the way to have it read.
 */
/** A snippet as HTML, its marked passages wrapped in <mark>. */
function markedText({
  text,
  marks,
}: NonNullable<ApiSearchHit["snippet"]>): Html {
  const parts: Html[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    parts.push(
      html`${text.slice(at, from)}<mark>${text.slice(from, to)}</mark>`,
    );
    at = to;
  }
  return html`${parts}${text.slice(at)}`;
}

function documentCard(d: ApiDocument): HTMLButtonElement {
  const card = document.createElement("button");
  const enriching = state.enriching.has(d.hash);
  const errored = state.errored.has(d.hash);
  const queued = state.queued.has(d.hash);
  const waiting = isWaiting(d);
  card.dataset.hash = d.hash;
  card.className = `card${enriching ? " enriching" : ""}${errored ? " errored" : ""}${waiting ? " waiting" : ""}`;
  const who = [partyLabel(d.sender), partyLabel(d.receiver)]
    .filter(Boolean)
    .join(" → ");
  const overlay = enriching
    ? html`<div class="working"><div class="spinner"></div>Processing…</div>`
    : errored
      ? html`<div class="working err"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg><span>Processing failed<br><span class="retry-hint">click to retry</span></span></div>`
      : queued
        ? html`<div class="working wait">Queued to be processed</div>`
        : waiting &&
          html`<div class="working wait"><span>Waiting to be processed${!state.provider && html`<br><span class="retry-hint">no provider chosen</span>`}</span></div>`;
  // Found only through its Transcription: nothing else on the card says why it
  // is here, so the passage that matched takes the summary's place.
  const snippet = hitFor(d.hash)?.snippet;
  const passage =
    snippet && html`<div class="snippet passage">${markedText(snippet)}</div>`;
  setHtml(
    card,
    html`
      <div class="thumb">
        <span class="ph">${kind(d)}</span>
        <img class="bg" src="/api/documents/${d.hash}/thumb" loading="lazy" alt="" aria-hidden="true" data-hide-on-error>
        <img class="fg" src="/api/documents/${d.hash}/thumb" loading="lazy" alt="" data-hide-on-error>
        ${overlay}
      </div>
      <div class="body">
        <div class="name">${titleOf(d)}</div>
        ${passage || (d.summary && html`<div class="snippet">${d.summary}</div>`)}
        ${who && html`<div class="who">${who}</div>`}
        <div class="meta"><span class="dt">${d.date ? fmtDate(d.date) : html`<span class="undated">undated</span>`}</span></div>
      </div>`,
  );
  card.onclick = errored ? () => enrichDoc(d.hash) : () => openDoc(d);
  return card;
}

/** A grid of cards, as the gallery and an entity's page both show Documents. */
function documentGrid(docs: ApiDocument[]): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const d of docs) grid.appendChild(documentCard(d));
  return grid;
}

function renderDocuments(list: ApiDocument[]) {
  if (!state.docs.length) {
    setHtml(
      view,
      state.provider
        ? html`<div class="state state-empty"><h2>No documents yet</h2><p>Drag files anywhere, or click here to browse.</p><p class="hint">PDFs and images are added and processed automatically.</p></div>`
        : html`<div class="state state-empty"><h2>No documents yet</h2><p>Drag files anywhere, or click here to browse.</p><p class="hint">Documents are added straight away, and processed once you <button type="button" class="settings-link">choose a provider in Settings</button>.</p></div>`,
    );
    return;
  }
  if (!list.length) {
    setHtml(
      view,
      html`<div class="state"><h2>Nothing matches</h2><p>Try a different search.</p></div>`,
    );
    return;
  }
  view.replaceChildren(...waitingNotice(), documentGrid(list));
}

/** The Documents filed but not yet read, whichever view is showing. */
const waitingDocs = () => state.docs.filter(isWaiting);

/**
 * Above the gallery while Documents wait: how many, and the one thing that
 * gets them read — choosing a Provider, or, once there is one, sending them.
 * Absent while nothing waits.
 */
function waitingNotice(): HTMLElement[] {
  const n = waitingDocs().length;
  if (!n) return [];
  const notice = document.createElement("div");
  notice.className = "waiting-notice";
  setHtml(
    notice,
    state.provider
      ? html`<span>${n} ${documentWord(n)} waiting to be processed by ${state.provider.model}.</span><button type="button" class="read-waiting">Process them now</button>`
      : html`<span>${n} ${documentWord(n)} waiting to be processed. No provider has been chosen to process them.</span><button type="button" class="settings-link">Choose a provider</button>`,
  );
  return [notice];
}

// ---- one entity's own page ------------------------------------------------

/** What each part an entity played is called where its Documents are grouped. */
const ROLE_HEADINGS: Record<AppearanceRole, string> = {
  sender: "Sender",
  receiver: "Receiver",
  mentioned: "Mentioned",
};

/** The count under an entity's name, in words because it is the page's subject. */
const documentsLine = (documents: number) =>
  `${documents} ${documentWord(documents)}`;

/**
 * The names that look like this entity's own, put to the owner on the page
 * where they can be answered — and said to be questions, because nothing has
 * been merged and nothing will be until the owner says so. Absent, rather than
 * empty, when nothing looks like it.
 */
function suspectedBlock(page: ApiEntityPage): HTMLElement[] {
  if (!page.suspected.length) return [];
  const block = document.createElement("section");
  block.className = "ep-alike";
  setHtml(
    block,
    html`
    <h3>Possibly the same</h3>
    <p class="ep-note">Nothing has changed: these are only questions.</p>
    <ul>${page.suspected.map(
      (e) => html`<li>
          <a href="${entityPath(page.kind, e.id)}">${e.displayName}</a>
          ${countLabel(e.documents)}
          <button type="button" class="ep-same" data-same-as="${e.id}">Same as…</button>
        </li>`,
    )}</ul>`,
  );
  return [block];
}

/**
 * One Person or Organization: what the Library knows it is called, and its
 * Documents under the part it played in each.
 *
 * The header's search and sort are the Document view's, so they are left alone
 * here: this page is one entity's paperwork rather than a result, and the role
 * grouping is the order it is in. Within a group the Documents are newest first,
 * by the same rule the gallery's own default follows.
 */
function renderEntity(id: number) {
  const held = state.entity;
  // Still being read. The address is right — the server answered it — so there
  // is nothing to say yet rather than something to apologize for.
  if (!held || held.id !== id) return view.replaceChildren();
  if (held.gone)
    return renderNothing(
      "Nothing is listed at this address",
      "Either it never named anyone, or that name's last document has since been deleted — a name's spellings are remembered, so adding that document again brings it back as it was.",
    );
  const page = held.page;
  if (!page) return view.replaceChildren();

  // A fact is text or markup: what links to another page is markup on purpose.
  const facts: [label: string, value: HtmlValue][] = [
    // Stated even when there is one spelling: this page is where a Merge is
    // checked, and "written as" answers that question whatever the answer is.
    ["Written as", page.variants.join(", ")],
  ];
  if (page.affiliations.length)
    facts.push([
      "Appeared for",
      join(
        page.affiliations.map(
          (a) =>
            html`<a href="${entityPath("organization", a.id)}">${a.displayName}</a>`,
        ),
        html`, `,
      ),
    ]);
  // Each name merged in is named in its own right rather than only spelled out
  // among the variants, because each is one Merge and each can be taken back on
  // its own — which is what the button beside it does.
  if (page.mergedNames.length)
    facts.push([
      "Also listed as",
      page.mergedNames.map(
        (m) =>
          html`<span class="ep-merged">${m.displayName}<button type="button" class="ep-undo" data-unmerge="${m.id}">Separate</button></span>`,
      ),
    ]);

  // Whom this one could be merged with: every other entity of its kind the
  // lists hold. With none, the action is shown refused rather than hidden, so
  // the page reads the same however small the Library is — and says the Library
  // holds nobody else only when the lists have actually been read.
  const candidates = state.browse
    ? listedEntities(state.browse, page.kind).filter((e) => e.id !== page.id)
    : [];
  const refused = candidates.length
    ? ""
    : state.browse
      ? html` disabled title="The library holds no other ${page.kind === "person" ? "person" : "organization"} to be the same as"`
      : html` disabled`;

  // Where the mark is made, and the only place it is: from the page of the
  // Person it is about, so the reader's own name never has to be typed in
  // anywhere. Only one of the People can be the reader, so an Organization's
  // page offers nothing, and the Person already marked is labelled at the head
  // of her page rather than asked again.
  const mark =
    page.kind === "person" &&
    !isMe(page.id) &&
    html`<button type="button" class="me-btn" data-mark-me="${page.id}">This is me</button>`;

  const head = document.createElement("header");
  head.className = "ep-head";
  setHtml(
    head,
    html`
    <h2>${page.displayName}${isMe(page.id) && ME_TAG}</h2>
    <p class="ep-count">${documentsLine(page.documents)}</p>
    <dl class="kv ep-facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    <div class="ep-actions">
      <button type="button" class="ep-same" data-same-as=""${refused}>Same as…</button>
      ${mark}
    </div>`,
  );

  const sections = page.roles.flatMap((group) => {
    const docs = searchDocuments(
      group.hashes
        .map((hash) => state.docs.find((d) => d.hash === hash))
        .filter((d): d is ApiDocument => d !== undefined),
      { hits: null, sort: "new" },
    );
    if (!docs.length) return [];
    const block = document.createElement("section");
    block.className = "ep-role";
    const heading = document.createElement("h3");
    setHtml(
      heading,
      html`${ROLE_HEADINGS[group.role]}${countLabel(docs.length)}`,
    );
    block.append(heading, documentGrid(docs));
    return [block];
  });

  const article = document.createElement("div");
  article.className = "ent-page";
  article.append(head, ...suspectedBlock(page), ...sections);

  // Every way into a Merge is a button on this page, so each is wired to the
  // one dialog: the entity it would merge with is named by the button when the
  // owner reached for a suggestion, and chosen in the dialog when they did not.
  for (const button of article.querySelectorAll<HTMLButtonElement>(
    "button[data-same-as]",
  ))
    button.onclick = () =>
      openSameAs(page, candidates, Number(button.dataset.sameAs) || null);
  for (const button of article.querySelectorAll<HTMLButtonElement>(
    "button[data-unmerge]",
  ))
    button.onclick = () => takeMergeBack(Number(button.dataset.unmerge));
  for (const button of article.querySelectorAll<HTMLButtonElement>(
    "button[data-mark-me]",
  ))
    button.onclick = () => markMe(Number(button.dataset.markMe));

  view.replaceChildren(article);
}

// ---- saying that two names are one ----------------------------------------

const sameAs = el<HTMLDialogElement>("same-as");
const sameAsIntro = el("same-as-intro");
const sameAsWho = el<HTMLSelectElement>("same-as-who");
const sameAsName = el<HTMLSelectElement>("same-as-name");
const sameAsSpelling = el<HTMLInputElement>("same-as-spelling");
const sameAsStatus = el("same-as-status");
const sameAsSubmit = el<HTMLButtonElement>("same-as-submit");

/** The entity the open dialog would merge, and the names it can be merged with. */
type SameAsState = { page: ApiEntityPage; candidates: ApiEntity[] };
let sameAsState: SameAsState | null = null;

/** A name with the Documents behind it, which is what tells two spellings apart. */
const withCount = (e: ApiEntity) =>
  `${e.displayName} — ${documentsLine(e.documents)}`;

/** The name picked to be merged with, as the dialog's picker has it. */
const pickedEntity = (): ApiEntity | undefined =>
  sameAsState?.candidates.find((e) => e.id === Number(sameAsWho.value));

/**
 * Which displayed name the owner has asked for, as the Library's merge takes it:
 * a spelling, or nothing at all when they left the choice to the Library.
 *
 * The default is the most frequent variant, and it is the Library that knows
 * which that is — it counts the Documents behind each spelling itself, not the
 * group each brings with it. So the browser asks for no name rather than
 * working one out: a second rule here could only disagree with the first.
 *
 * The choice is read back from which option was picked rather than from the
 * option's own text, so that a Person actually called "Another spelling" is a
 * name like any other.
 */
function chosenName(): string | undefined {
  switch (sameAsName.value) {
    case "this":
      return sameAsState?.page.displayName;
    case "other":
      return pickedEntity()?.displayName;
    case "spelling":
      return sameAsSpelling.value.trim();
    default:
      return undefined; // the most frequent variant, which the Library knows
  }
}

/** Say why the Library refused, in the dialog that asked, leaving it open. */
function sameAsRefused(why: string) {
  sameAsStatus.textContent = why;
  sameAsStatus.classList.add("err");
}

/**
 * Offer the names the picked entity and this one could be shown under: either
 * spelling, one the owner types, or — the default — whichever the Library finds
 * most frequent. Rebuilt as the pick changes, since one of the two names does.
 */
function renderNameChoice() {
  const held = sameAsState;
  if (!held) return;
  const other = pickedEntity();
  const choices: [value: string, label: string][] = [
    ["frequent", "Whichever name has more documents"],
    ["this", `Show “${held.page.displayName}”`],
    ...(other
      ? ([["other", `Show “${other.displayName}”`]] as [string, string][])
      : []),
    ["spelling", "Show another spelling…"],
  ];
  sameAsName.replaceChildren(
    ...choices.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  sameAsSpelling.hidden = true;
}

/**
 * Ask which other name is the same as this one. Opened from the entity's own
 * page — where the owner can see what they would be merging — either with the
 * look-alike they reached for already picked, or with the choice open.
 */
function openSameAs(
  page: ApiEntityPage,
  candidates: ApiEntity[],
  picked: number | null,
) {
  if (!candidates.length) return;
  sameAsState = { page, candidates };
  sameAsIntro.textContent = `This says that “${page.displayName}” and another name are one ${page.kind}. Nothing is discarded, and you can take it back.`;
  sameAsWho.replaceChildren(
    ...candidates.map((e) => {
      const option = document.createElement("option");
      option.value = String(e.id);
      option.textContent = withCount(e);
      return option;
    }),
  );
  if (picked !== null && candidates.some((e) => e.id === picked))
    sameAsWho.value = String(picked);
  renderNameChoice();
  sameAsSpelling.value = "";
  sameAsStatus.textContent = "";
  sameAsStatus.classList.remove("err");
  sameAsSubmit.disabled = false;
  sameAs.showModal();
}

/**
 * Say it: the two names are one. The Library decides which spelling survives
 * unless the owner chose one, so the answer is what the page is drawn from
 * afterwards rather than a guess made here — and the owner is taken to the
 * surviving name's own address, which is where the merged Library now is.
 */
async function confirmSameAs() {
  const held = sameAsState;
  if (!held) return;
  const other = Number(sameAsWho.value);
  const displayName = chosenName();
  if (sameAsName.value === "spelling" && !displayName) {
    sameAsRefused("Type the spelling to show, or let Zayla choose.");
    return;
  }
  sameAsSubmit.disabled = true;
  sameAsStatus.classList.remove("err");
  sameAsStatus.textContent = "Saving…";
  let res: Response;
  try {
    res = await fetch("/api/merges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: held.page.id, b: other, displayName }),
    });
  } catch {
    sameAsSubmit.disabled = false;
    sameAsRefused("Couldn't reach the library.");
    return;
  }
  if (res.status === 401) {
    sameAs.close();
    refreshAuth();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as ApiMergeOutcome & {
    error?: string;
  };
  if (!res.ok || body.error) {
    sameAsSubmit.disabled = false;
    sameAsRefused(body.error || `Couldn't save (HTTP ${res.status}).`);
    return;
  }
  sameAs.close();
  toast(
    `${body.absorbed.displayName} is now ${body.survivor.displayName} — ${documentsLine(body.survivor.documents)}`,
  );
  navigate(entityPath(held.page.kind, body.survivor.id));
  await reloadBrowse();
}

/**
 * Take one Merge back from the page of the name that holds it. Nothing was
 * moved when it was made, so nothing is put back wrongly: both names are left
 * exactly as they stood, which is why this asks for no confirmation.
 */
async function takeMergeBack(absorbed: number) {
  let res: Response;
  try {
    res = await fetch(`/api/merges/${absorbed}`, { method: "DELETE" });
  } catch {
    toast("Couldn't reach the library.", true);
    return;
  }
  if (res.status === 401) {
    refreshAuth();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as ApiUnmergeOutcome & {
    error?: string;
  };
  if (!res.ok || body.error) {
    toast(body.error || `Couldn't separate (HTTP ${res.status}).`, true);
    return;
  }
  toast(
    `${body.restored.displayName} is a name of its own again — ${documentsLine(body.restored.documents)}`,
  );
  await reloadBrowse();
}

sameAsWho.addEventListener("change", renderNameChoice);
sameAsName.addEventListener("change", () => {
  sameAsSpelling.hidden = sameAsName.value !== "spelling";
  if (!sameAsSpelling.hidden) sameAsSpelling.focus();
});
el<HTMLFormElement>("same-as-form").addEventListener("submit", (e) => {
  e.preventDefault();
  confirmSameAs();
});
el("same-as-cancel").addEventListener("click", () => sameAs.close());

/**
 * Say that this Person is the reader. The mark is theirs alone — another user of
 * the same Library has their own, and the Documents are shared as they always
 * were — so the answer only changes what this reader is shown.
 *
 * The answer names who is Me afterwards, which is taken as said: the page
 * labels her at once even if re-reading the Library then fails, because the
 * mark was made either way. How the lists are then arranged for her is the
 * Library's to decide, so that much is re-read rather than guessed at here.
 */
async function markMe(id: number) {
  let res: Response;
  try {
    res = await fetch(`/api/entities/${id}/me`, { method: "POST" });
  } catch {
    toast("Couldn't reach the library.", true);
    return;
  }
  if (res.status === 401) {
    refreshAuth();
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    me?: number;
    error?: string;
  };
  if (!res.ok || body.error) {
    toast(body.error || `Couldn't mark (HTTP ${res.status}).`, true);
    return;
  }
  if (state.browse && body.me !== undefined) state.browse.me = body.me;
  render();
  await reloadBrowse();
}

let lastFocus: Element | null = null;
let openHash: string | null = null;
function openDoc(d: ApiDocument) {
  lastFocus = document.activeElement;
  openHash = d.hash;
  drawPanel(d);
  const pages = pagesHtml(d);
  const viewer = el("viewer");
  if (pages) setHtml(viewer, pages);
  else viewer.replaceChildren();
  viewer.scrollTop = 0;
  const scrim = el("scrim");
  scrim.scrollTop = 0; // a phone's sheet scrolls as a whole, from the first page
  scrim.classList.toggle("has-preview", pages !== null);
  scrim.classList.add("shown");
  el("panel").querySelector<HTMLButtonElement>(".p-close")?.focus();
}

/** What the panel says about a Document: drawn on opening, and again when it is read. */
function drawPanel(d: ApiDocument) {
  const panel = el("panel");
  const hasPreview = pagesHtml(d) !== null;

  const fmtParty = (p: Party | null) =>
    p && (p.organization || p.person)
      ? (p.organization || p.person) +
        (p.organization && p.person ? ` (${p.person})` : "")
      : "";
  const from = fmtParty(d.sender);
  const to = fmtParty(d.receiver);
  const kv: [label: string, value: HtmlValue][] = [];
  if (from) kv.push(["From", from]);
  if (to) kv.push(["To", to]);
  if (d.people?.length) kv.push(["People", join(d.people, html`<br>`)]);
  if (d.date) kv.push(["Date", fmtDate(d.date)]);
  if (d.deadlines?.length)
    kv.push([
      "Deadlines",
      join(
        d.deadlines.map((x) => `${x.label} — ${fmtDate(x.date)}`),
        html`<br>`,
      ),
    ]);
  if (d.languages?.length) kv.push(["Languages", d.languages.join(", ")]);

  setHtml(
    panel,
    html`
    <div class="p-head">
      <button class="p-close" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      ${!hasPreview && html`<div class="p-thumb"><img src="/api/documents/${d.hash}/thumb" alt="" data-hide-on-error=".p-thumb"></div>`}
      <div class="p-head-text">
        <h2 id="p-title">${titleOf(d)}</h2>
      </div>
    </div>
    ${d.summary && html`<div class="p-sec"><h3>Summary</h3><p class="p-summary">${d.summary}</p></div>`}
    ${kv.length > 0 && html`<div class="p-sec"><h3>Details</h3><dl class="kv">${kv.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></div>`}
    <div class="p-sec">
      <h3>File</h3>
      <dl class="kv">
        <dt>Format</dt><dd>${d.mime}</dd>
        <dt>Size</dt><dd class="mono">${fmtSize(d.bytes)}</dd>
        <dt>Added</dt><dd>${fmtDate(d.addedAt)}</dd>
        <dt>Status</dt><dd>${d.status === "enriched" ? "Processed" : "Waiting to be processed"}</dd>
      </dl>
      <div class="p-file">${d.filename} · ${d.hash.slice(0, 16)}…</div>
    </div>
    <div class="p-bar" id="p-bar"></div>`,
  );
  const closeBtn = panel.querySelector<HTMLButtonElement>(".p-close");
  if (closeBtn) closeBtn.onclick = closeDoc;
  renderActions(d);
}
/**
 * A Document's pages for the viewer, as images the server rendered: the same
 * in every browser, unlike its built-in PDF viewer. Each loads as it nears the
 * viewport. A PDF whose pages couldn't be counted shows one page, which the
 * server can't render either, so it becomes the placeholder offering the
 * Original. Empty for a Document with no pages to show.
 */
function pagesHtml(d: ApiDocument): Html | null {
  if (d.mime !== "application/pdf" && !d.mime.startsWith("image/")) return null;
  const count = d.pages ?? 1;
  const pages = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return html`<figure class="page"><img src="/api/documents/${d.hash}/pages/${n}" loading="lazy" decoding="async" alt="Page ${n} of ${count}"></figure>`;
  });
  return html`<div class="pages" data-hash="${d.hash}">${pages}</div>`;
}

/** What a page that couldn't be shown says in its place: the Original is still there. */
function missingPage(page: HTMLElement, hash: string) {
  page.classList.add("page-missing");
  setHtml(
    page,
    html`
    <p>This page couldn't be shown here.</p>
    <a class="open" href="/api/documents/${hash}/original" target="_blank" rel="noopener">Open original</a>`,
  );
}

/** The open Document, if it is this one and is still in the Library. */
const openDocument = (hash: string) =>
  openHash === hash ? state.docs.find((d) => d.hash === hash) : undefined;

/**
 * Bring the actions up to date, if this Document is the open one. A question
 * being asked stays: its answer redraws them.
 */
function redrawActions(hash: string) {
  const d = openDocument(hash);
  if (d && !el("p-bar").querySelector(".confirm")) renderActions(d);
}

/**
 * Show a finished reading, if this Document is the open one. The button that
 * had focus was disabled while it read, so focus returns to the action, unless
 * it has since moved outside the panel.
 */
function redrawPanel(hash: string) {
  const d = openDocument(hash);
  if (!d) return;
  const active = document.activeElement;
  const focusHere = active === document.body || el("panel").contains(active);
  const askingDelete = el("p-bar").querySelector(".del-btn.confirm") !== null;
  drawPanel(d);
  if (askingDelete) renderDeleteAsk(d);
  else if (focusHere)
    el("p-bar").querySelector<HTMLElement>(".proc-btn")?.focus();
}

/** The Process action's icon, turning while its Document is read. */
const PROCESS_ICON = html`<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>`;

// What can be done with the open Document, along the foot of the panel. What
// can't be undone asks first, in the same place. A Document waiting to be read
// goes straight to the Provider; one already read asks, since the reading it
// has can't be made again.
function renderActions(d: ApiDocument) {
  const bar = el("p-bar");
  const busy = state.enriching.has(d.hash) || state.queued.has(d.hash);
  const again = d.status === "enriched";
  const label = again ? "Process again" : "Process";
  setHtml(
    bar,
    html`
    ${!busy && !state.provider && html`<p class="proc-note">No provider chosen. <button type="button" class="settings-link">Choose a provider</button></p>`}
    <div class="p-actions">
      <a class="open" href="/api/documents/${d.hash}/original" target="_blank" rel="noopener">
        Open original
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M9 7h8v8"/></svg>
      </a>
      <button class="proc-btn${busy ? " busy" : ""}" type="button">${PROCESS_ICON}${busy ? "Processing…" : label}</button>
      <button class="del-btn quiet" type="button" aria-label="Delete document">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
        <span>Delete</span>
      </button>
    </div>`,
  );
  const link = bar.querySelector<HTMLButtonElement>(".settings-link");
  if (link)
    link.onclick = () => {
      closeDoc();
      openSettings("provider");
    };
  const process = bar.querySelector<HTMLButtonElement>(".proc-btn");
  if (process) {
    process.disabled = busy || !state.provider;
    process.onclick = () => (again ? renderProcessAsk(d) : processDoc(d));
  }
  const del = bar.querySelector<HTMLButtonElement>(".del-btn");
  if (del) del.onclick = () => renderDeleteAsk(d);
}
function renderProcessAsk(d: ApiDocument) {
  const bar = el("p-bar");
  setHtml(
    bar,
    html`
    <p class="p-ask">Process again with <strong>${state.provider?.model}</strong>? This replaces the ${d.readBy ? html`result from <strong>${d.readBy}</strong>` : "current result"} and can't be undone.</p>
    <div class="p-actions">
      <button class="proc-btn confirm" type="button">${PROCESS_ICON}Process again</button>
      <button class="proc-btn" type="button">Cancel</button>
    </div>`,
  );
  const [confirm, cancel] = bar.querySelectorAll<HTMLButtonElement>("button");
  if (cancel)
    cancel.onclick = () => {
      renderActions(d);
      bar.querySelector<HTMLElement>(".proc-btn")?.focus();
    };
  if (confirm) {
    confirm.onclick = () => processDoc(d);
    confirm.focus();
  }
}
function processDoc(d: ApiDocument) {
  sendToProvider([d.hash]);
  renderActions(d);
}

// Delete is permanent — no trash, no undo — so it asks first, naming what will
// be gone.
function renderDeleteAsk(d: ApiDocument) {
  const bar = el("p-bar");
  setHtml(
    bar,
    html`
    <p class="p-ask">Delete <strong>${titleOf(d)}</strong> permanently? This can't be undone.</p>
    <div class="p-actions">
      <button class="del-btn confirm" type="button">Delete</button>
      <button class="del-btn cancel" type="button">Cancel</button>
    </div>`,
  );
  const [confirm, cancel] = bar.querySelectorAll<HTMLButtonElement>("button");
  if (cancel)
    cancel.onclick = () => {
      renderActions(d);
      bar.querySelector<HTMLElement>(".del-btn")?.focus();
    };
  if (confirm) {
    confirm.onclick = () => deleteDoc(d, confirm);
    confirm.focus();
  }
}
async function deleteDoc(d: ApiDocument, btn: HTMLButtonElement) {
  btn.disabled = true;
  let res: Response;
  try {
    res = await fetch(`/api/documents/${d.hash}`, { method: "DELETE" });
  } catch (err) {
    btn.disabled = false;
    toast(`Couldn't delete: ${(err as Error).message}`, true);
    return;
  }
  // Already gone, from another tab or another user of the Library: the outcome
  // asked for is the outcome there is.
  if (!res.ok && res.status !== 404) {
    btn.disabled = false;
    toast(`Couldn't delete (HTTP ${res.status}).`, true);
    return;
  }
  closeDoc();
  toast(`Deleted “${titleOf(d)}”`);
  await forgetDoc(d.hash);
}

function closeDoc() {
  const scrim = el("scrim");
  scrim.classList.remove("shown");
  scrim.classList.remove("has-preview");
  el("viewer").replaceChildren(); // stop loading the original
  // The card that opened it, or the one drawn in its place if the grid was
  // redrawn meanwhile, as it is while other Documents are being read.
  const card = lastFocus?.isConnected
    ? lastFocus
    : document.querySelector(`.card[data-hash="${openHash}"]`);
  if (card instanceof HTMLElement) card.focus();
  openHash = null;
}

el("scrim").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "scrim") closeDoc();
});
// The canvas around the pages is the scrim's to click, as it is beside the
// panel. Not on a phone, where the pages fill the sheet and a tap beside one
// is a tap on the sheet.
el("viewer").addEventListener("click", (e) => {
  if (phone.matches) return;
  const target = e.target as HTMLElement;
  if (target.id === "viewer" || target.classList.contains("pages")) closeDoc();
});
// A page's image takes its own shape once loaded, or gives way to the
// placeholder if it can't be. Neither event bubbles, so they're caught on the way down.
el("viewer").addEventListener(
  "load",
  (e) => (e.target as HTMLElement).closest(".page")?.classList.add("loaded"),
  true,
);
el("viewer").addEventListener(
  "error",
  (e) => {
    const img = e.target as HTMLElement;
    const page = img.closest<HTMLElement>(".page");
    const hash = img.closest<HTMLElement>(".pages")?.dataset.hash;
    if (page && hash) missingPage(page, hash);
  },
  true,
);
// A thumbnail that can't be had steps aside for what is under it: the image
// itself, or the nearest ancestor its `data-hide-on-error` names. Caught here
// rather than in an `onerror` attribute, which the page's CSP refuses to run.
document.addEventListener(
  "error",
  (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    const hide = e.target.dataset.hideOnError;
    if (hide === undefined) return;
    const gone = hide ? e.target.closest<HTMLElement>(hide) : e.target;
    if (gone) gone.style.display = "none";
  },
  true,
);
// Only while a Document is open: closing hands focus back to the card that
// opened it, which an Escape meant for anything else must not do.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el("scrim").classList.contains("shown")) closeDoc();
});
// Tab stays in the open Document, coming round from its last control to its
// first: the Library behind it is out of reach until it is closed.
document.addEventListener("keydown", (e) => {
  const scrim = el("scrim");
  if (e.key !== "Tab" || !scrim.classList.contains("shown")) return;
  const controls = Array.from(
    scrim.querySelectorAll<HTMLElement>(
      "a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((c) => c.getClientRects().length > 0);
  const active = document.activeElement;
  const at = controls.indexOf(active as HTMLElement);
  // Somewhere inside that isn't a control, like the scrolling pages, which the
  // browser knows its way on from.
  if (at === -1 && active && scrim.contains(active)) return;
  const to = wrapFocus(controls.length, at, e.shiftKey);
  if (to === null) return;
  e.preventDefault();
  controls[to]?.focus();
});
// Search and sort read the whole Library, not the destination being viewed, so
// they stay in the header and only re-render — the count reflects a query from
// anywhere, and the Document view shows the result when you reach it.
el<HTMLInputElement>("q").addEventListener("input", (e) => {
  const q = (e.target as HTMLInputElement).value;
  state.sort = sortAfterTyping(state.q, q, state.sort);
  state.q = q;
  syncSortControl();
  clearTimeout(searchTimer);
  // Clearing the box shows the whole Library at once; there is nothing to ask.
  if (!q.trim()) void runSearch();
  else searchTimer = setTimeout(runSearch, SEARCH_PAUSE_MS);
});
el<HTMLSelectElement>("sort").addEventListener("change", (e) => {
  state.sort = (e.target as HTMLSelectElement).value as SortKey;
  render();
});

// ---- a phone's header -----------------------------------------------------

/** Whether the layout is a phone's: the breakpoint index.html switches at. */
const phone = matchMedia("(max-width: 760px)");

/**
 * The sort control sits in the header on a desktop and above the Documents on
 * a phone, whose compact bar has no room for it. One control, moved, so there
 * is never a second one to keep in step.
 */
function placeSort() {
  const sort = el("sort");
  if (phone.matches) el("view-tools").append(sort);
  else el("add-btn").before(sort);
}
phone.addEventListener("change", placeSort);
placeSort();

// On a phone, search is a button that opens the field across the whole bar.
// Closing it clears the query, so no search goes on filtering out of sight.
const topBar = el("top");
const searchInput = el<HTMLInputElement>("q");
const searchOpen = el<HTMLButtonElement>("search-open");

function expandSearch(on: boolean) {
  topBar.classList.toggle("searching", on);
  searchOpen.setAttribute("aria-expanded", String(on));
}

searchOpen.addEventListener("click", () => {
  expandSearch(true);
  searchInput.focus();
});

function closeSearch() {
  if (searchInput.value) {
    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input"));
  }
  expandSearch(false);
  searchOpen.focus();
}

el("search-close").addEventListener("click", closeSearch);
searchInput.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    phone.matches &&
    topBar.classList.contains("searching")
  )
    closeSearch();
});

/**
 * A button that drops a menu of actions: opened by a click or the arrow keys,
 * walked with the arrows, Home and End, and closed by Escape, a click outside
 * it or choosing an action — each of which hands focus back to the button.
 * Returns the close, for the actions to call before they act.
 */
function menuButton(button: HTMLButtonElement, menu: HTMLElement) {
  const items = () =>
    Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const open = (at: "first" | "last") => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const list = items();
    (at === "first" ? list[0] : list.at(-1))?.focus();
  };
  const close = (returnFocus = true) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (returnFocus) button.focus();
  };
  button.addEventListener("click", () =>
    menu.hidden ? open("first") : close(),
  );
  button.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    open(e.key === "ArrowDown" ? "first" : "last");
  });
  menu.addEventListener("keydown", (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const step = (by: number) =>
      list[(at + by + list.length) % list.length]?.focus();
    switch (e.key) {
      case "Escape":
        close();
        break;
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
        list[0]?.focus();
        break;
      case "End":
        list.at(-1)?.focus();
        break;
      case "Tab":
        // Back on the button first, so Tab carries on from there instead of
        // from an item that is about to disappear.
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
  });
  // Pressed rather than clicked: a tap on something that is not a control
  // fires no click in iOS Safari. A control tapped outside keeps the focus it
  // takes; anything else returns focus to the button.
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden || !(e.target instanceof Element)) return;
    if (menu.contains(e.target) || button.contains(e.target)) return;
    close(!e.target.closest("a, button, input, select, textarea, [tabindex]"));
  });
  return close;
}

const moreBtn = el<HTMLButtonElement>("more-btn");
const closeAddMenu = menuButton(
  el<HTMLButtonElement>("add-menu-btn"),
  el("add-menu"),
);
const closeMoreMenu = menuButton(moreBtn, el("more-menu"));

// ---- upload + enrichment --------------------------------------------------

// Replace-or-append a doc by hash, so an import and a later enrich of the same
// file update the same card in place.
function upsertDoc(d: ApiDocument) {
  const i = state.docs.findIndex((x) => x.hash === d.hash);
  if (i === -1) state.docs.push(d);
  else state.docs[i] = { ...state.docs[i], ...d } as ApiDocument;
}

// Drop a Deleted Document from everything this page holds about it, so it is
// neither shown nor sent to the Provider again. Its Appearances went with it,
// so who the Library involves has changed too.
async function forgetDoc(hash: string) {
  state.docs = state.docs.filter((x) => x.hash !== hash);
  state.recent = state.recent.filter((h) => h !== hash);
  state.queued.delete(hash);
  state.errored.delete(hash);
  render();
  await reloadBrowse();
}

function toast(msg: string, isErr = false) {
  const node = document.createElement("div");
  node.className = `toast${isErr ? " err" : ""}`;
  node.textContent = msg;
  el("toasts").appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(
    () => {
      node.classList.remove("show");
      setTimeout(() => node.remove(), 250);
    },
    isErr ? 5000 : 3000,
  );
}

// Enrich one document (vision call). The card shows a spinner while in flight
// and an error/retry state on failure.
async function enrichDoc(hash: string) {
  state.errored.delete(hash);
  state.enriching.add(hash);
  render();
  redrawActions(hash);
  try {
    const res = await fetch(`/api/documents/${hash}/enrich`, {
      method: "POST",
    });
    const body = (await res.json().catch(() => ({}))) as ApiDocument & {
      error?: string;
      noProvider?: boolean;
    };
    // Cleared since this page last asked: the Document waits, it did not fail.
    if (body.noProvider) {
      state.provider = null;
      return;
    }
    // Deleted while it was being read: the reading was discarded, and there is
    // nothing to retry.
    if (res.status === 404) {
      await forgetDoc(hash);
      return;
    }
    if (!res.ok || body.error)
      throw new Error(body.error || `HTTP ${res.status}`);
    upsertDoc(body);
    // What it can be found by has changed with it.
    refreshSearch();
    // The reading just recorded this Document's Appearances, so who the Library
    // involves has changed: the lists and the shortcuts are now out of date.
    await reloadBrowse();
  } catch (err) {
    // A Document already read keeps its reading, so its card has nothing to
    // retry: only one with no reading has failed.
    const doc = state.docs.find((d) => d.hash === hash);
    if (doc?.status !== "enriched") state.errored.add(hash);
    toast(`Couldn't process: ${(err as Error).message}`, true);
  } finally {
    state.enriching.delete(hash);
    render();
    redrawPanel(hash);
  }
}

type ImportItem = ApiDocument & { error?: string; deduped?: boolean };

// Import dropped/picked files (fast), show them immediately, then enrich each.
async function uploadFiles(fileList: FileList | null) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append("files", f);

  let imported: ImportItem[];
  try {
    const res = await fetch("/api/documents", { method: "POST", body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    imported = (await res.json()) as ImportItem[];
  } catch (err) {
    toast(`Couldn't add: ${(err as Error).message}`, true);
    return;
  }

  const toEnrich: string[] = [];
  let dupes = 0;
  for (const item of imported) {
    if (item.error) {
      toast(`${item.filename || "file"}: ${item.error}`, true);
      continue;
    }
    if (item.deduped) dupes++;
    upsertDoc(item);
    if (!state.recent.includes(item.hash)) state.recent.unshift(item.hash);
    if (item.status !== "enriched") toEnrich.push(item.hash);
  }
  if (dupes) toast(`${dupes} already in your library`);
  state.loaded = true;
  render();
  // A new Document can already be found by its filename.
  refreshSearch();

  // With no Provider, what was filed waits to be read; nothing is sent.
  if (state.provider) sendToProvider(toEnrich);
}

/**
 * Send every waiting Document to the Provider — only ever on the owner's
 * word, since each is a model call and choosing a Provider sends nothing.
 */
const readWaiting = () => sendToProvider(waitingDocs().map((d) => d.hash));

/** Whether the queue is being worked through, so a second call only adds to it. */
let sending = false;

/**
 * Queue Documents to be read, and read the queue one at a time — sequential is
 * gentle on the API. Uploads, "Process them now" and the panel's Process share
 * the one queue, so a Document is never sent twice however they overlap. If the
 * Provider is cleared meanwhile, what is left goes back to waiting.
 */
async function sendToProvider(hashes: string[]) {
  for (const h of hashes) if (!state.enriching.has(h)) state.queued.add(h);
  render();
  if (sending) return;
  sending = true;
  try {
    for (const hash of state.queued) {
      if (!state.provider) break;
      state.queued.delete(hash);
      await enrichDoc(hash);
    }
  } finally {
    const stranded = openHash && state.queued.has(openHash) ? openHash : null;
    state.queued.clear();
    sending = false;
    render();
    if (stranded) redrawActions(stranded);
  }
}

const fileInput = el<HTMLInputElement>("file-input");
const cameraInput = el<HTMLInputElement>("camera-input");
el("add-btn").addEventListener("click", () => fileInput.click());
// A phone's Add asks first: a photo from the rear camera, or files. Either way
// what comes back is Imported like anything else.
el("take-photo").addEventListener("click", () => {
  closeAddMenu();
  cameraInput.click();
});
el("choose-files").addEventListener("click", () => {
  closeAddMenu();
  fileInput.click();
});
for (const input of [fileInput, cameraInput])
  input.addEventListener("change", () => {
    uploadFiles(input.files);
    input.value = "";
  });

// Window drag overlay. dragenter/over fire repeatedly, so count depth to know
// when the cursor has truly left the window before hiding the overlay.
const dropzone = el("dropzone");
let dragDepth = 0;
const hasFiles = (e: DragEvent) =>
  Array.from(e.dataTransfer?.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add("on");
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove("on");
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("on");
  uploadFiles(e.dataTransfer?.files ?? null);
});

// The empty-Library panel doubles as a click-to-browse target. No other state
// panel does, which is why it carries its own class.
view.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(".settings-link")) openSettings("provider");
  else if (e.target.closest(".read-waiting")) readWaiting();
  else if (e.target.closest(".state-empty")) fileInput.click();
});

// ---- Settings: the Provider ------------------------------------------------
// One Provider for the Library, chosen here and nowhere else. Its key is sent
// in and never comes back: the form knows only whether one is held. Saving
// makes no model call and reads nothing, so the Documents already waiting are
// offered as a separate, explicit step.

// Settings and Setup share the OpenRouter/Custom choice: OpenRouter takes no
// address and offers Zero retention; Custom takes an address and offers none.
// Each form's ids share a prefix, "prov" or "setup-prov".

/** Which kind a Provider form has chosen. */
function chosenKind(prefix: string): ProviderKind {
  const on = document.querySelector<HTMLInputElement>(
    `input[name="${prefix}-kind"]:checked`,
  );
  return on?.value === "custom" ? "custom" : "openrouter";
}

/**
 * Show the fields this kind asks for. The address is disabled while hidden,
 * so its `required` doesn't stop an OpenRouter form being sent.
 */
function showKind(prefix: string, kind: ProviderKind) {
  for (const radio of document.querySelectorAll<HTMLInputElement>(
    `input[name="${prefix}-kind"]`,
  ))
    radio.checked = radio.value === kind;
  el(`${prefix}-custom`).hidden = kind !== "custom";
  el<HTMLInputElement>(`${prefix}-url`).disabled = kind !== "custom";
  el(`${prefix}-openrouter`).hidden = kind !== "openrouter";
}

/**
 * Where a Provider form sends its Documents, as the server reads it both to
 * list models and to choose a Provider: OpenRouter with its Zero retention,
 * or Custom at its address.
 */
function destinationOf(prefix: string) {
  return chosenKind(prefix) === "openrouter"
    ? {
        kind: "openrouter" as const,
        zeroRetention: el<HTMLInputElement>(`${prefix}-zero-retention`).checked,
      }
    : {
        kind: "custom" as const,
        baseUrl: el<HTMLInputElement>(`${prefix}-url`).value.trim(),
      };
}

/** The key field's hint where no key is held for the destination. */
const noKeyHint = (kind: ProviderKind) =>
  kind === "openrouter"
    ? "Your OpenRouter key"
    : "None (a local server usually needs none)";

const settings = el<HTMLDialogElement>("settings");
const settingsBtn = el<HTMLButtonElement>("settings-btn");
const provUrl = el<HTMLInputElement>("prov-url");
const provZeroRetention = el<HTMLInputElement>("prov-zero-retention");
const provKey = el<HTMLInputElement>("prov-key");
const provKeyRemove = el<HTMLButtonElement>("prov-key-remove");
const provModel = el<HTMLInputElement>("prov-model");
const provModels = el<HTMLDataListElement>("prov-models");
const provFind = el<HTMLButtonElement>("prov-find");
const provStatus = el("prov-status");
const provWaiting = el("prov-waiting");
const provClear = el<HTMLButtonElement>("prov-clear");
const provSave = el<HTMLButtonElement>("prov-save");

/** Whether the held key is to be removed on save — set by "Remove key". */
let removeKey = false;

function setProvStatus(msg: string, isErr = false) {
  provStatus.textContent = msg;
  provStatus.classList.toggle("err", isErr);
}

/** Draw the form from the Provider the Library holds. */
function fillSettings() {
  const p = state.provider;
  // A user who has chosen nothing yet is offered OpenRouter, Zero retention on.
  showKind("prov", p?.kind ?? "openrouter");
  provUrl.value = p?.kind === "custom" ? p.baseUrl : "";
  provZeroRetention.checked = p?.kind === "openrouter" ? p.zeroRetention : true;
  provModel.value = p?.model ?? "";
  provKey.value = "";
  removeKey = false;
  showKeyHint();
  provClear.hidden = !p;
  provModels.replaceChildren();
  setProvStatus("");
  fillWaiting();
}

/** The "waiting" line: only with a Provider to send to, and something to send. */
function fillWaiting() {
  const n = waitingDocs().length;
  provWaiting.hidden = !state.provider || n === 0;
  setHtml(
    provWaiting,
    html`<span>${n} ${documentWord(n)} waiting to be processed.</span><button type="button" id="prov-read">Process them now</button>`,
  );
}

// One tab per part of Settings. Every form stays in the page while hidden, so
// what was typed in one survives a look at another; only opening Settings
// draws them afresh.
const settingsTabs = [
  ...settings.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];

/** The parts of Settings, each named by its tab. */
type SettingsTab = "provider" | "languages" | "signin";

function showSettingsTab(tab: HTMLButtonElement) {
  for (const t of settingsTabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    el(t.getAttribute("aria-controls") ?? "").hidden = !on;
  }
}

function openSettings(tab: SettingsTab = "provider") {
  fillSettings();
  fillLanguages();
  fillPassword();
  fillPasskey();
  const shown = el<HTMLButtonElement>(`settings-tab-${tab}`);
  showSettingsTab(shown);
  settings.showModal();
  // On the tab rather than its first field, so a phone opens no keyboard.
  shown.focus();
}

el("settings-tabs").addEventListener("click", (e) => {
  const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]');
  if (tab) showSettingsTab(tab);
});
el("settings-tabs").addEventListener("keydown", (e) => {
  const at = settingsTabs.indexOf(document.activeElement as HTMLButtonElement);
  const to = tabFor(e.key, settingsTabs.length, at);
  const tab = to === null ? undefined : settingsTabs[to];
  if (!tab) return;
  e.preventDefault();
  showSettingsTab(tab);
  tab.focus();
});

settingsBtn.addEventListener("click", () => openSettings());
// Closed first, so the dialog hands focus back to the "⋯" button when it closes.
el("more-settings").addEventListener("click", () => {
  closeMoreMenu();
  openSettings();
});
el("settings-close").addEventListener("click", () => settings.close());

provKeyRemove.addEventListener("click", () => {
  removeKey = true;
  provKey.value = "";
  provKey.placeholder = "The key will be removed when you save";
  provKeyRemove.hidden = true;
});
provKey.addEventListener("input", () => {
  if (provKey.value) removeKey = false;
});

/** Whether the key held is for where the form now sends Documents. */
function heldKeyApplies(): boolean {
  const p = state.provider;
  if (!p?.hasKey) return false;
  return chosenKind("prov") === "openrouter"
    ? p.kind === "openrouter"
    : p.kind === "custom" && provUrl.value.trim() === p.baseUrl;
}

// The held key belongs to the address it was given for, and the server will
// not carry it to another one — so say so as soon as the destination changes.
function showKeyHint() {
  if (removeKey) return;
  const kind = chosenKind("prov");
  const applies = heldKeyApplies();
  provKey.placeholder = applies
    ? "A key is set — type to replace it"
    : !state.provider?.hasKey
      ? noKeyHint(kind)
      : kind === "openrouter"
        ? "The key held is for your Custom address — enter your OpenRouter key"
        : "The key held is for the old address — enter one if this address needs it";
  provKeyRemove.hidden = !applies;
}

provUrl.addEventListener("input", showKeyHint);

// Another kind, or Zero retention turned on or off, offers other models: the
// ones listed before are dropped rather than offered for the wrong place.
el("settings-form")
  .querySelector(".prov-kind")
  ?.addEventListener("change", () => {
    showKind("prov", chosenKind("prov"));
    provModels.replaceChildren();
    setProvStatus("");
    showKeyHint();
  });
provZeroRetention.addEventListener("change", () => {
  provModels.replaceChildren();
  setProvStatus("");
});

/** Offer these models as a model field's suggestions; returns what to say about them. */
function offerModels(list: HTMLDataListElement, models: string[]): string {
  list.replaceChildren(
    ...models.map((id) => {
      const o = document.createElement("option");
      o.value = id;
      return o;
    }),
  );
  return models.length
    ? `${models.length} model${models.length === 1 ? "" : "s"} offered — pick one, or type an id.`
    : "That address offers no models; type the id instead.";
}

// Ask the address which models it offers. A typed key is used; without one,
// the server uses the key it holds for that same address, if any.
provFind.addEventListener("click", async () => {
  const destination = destinationOf("prov");
  if (destination.kind === "custom" && !destination.baseUrl) {
    setProvStatus("Enter the address first.", true);
    return;
  }
  provFind.disabled = true;
  setProvStatus("Asking for models…");
  try {
    const res = await fetch("/api/provider/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...destination,
        apiKey: provKey.value || undefined,
      }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    const { models } = (await res.json()) as { models: string[] };
    setProvStatus(offerModels(provModels, models));
    if (models.length) provModel.focus();
  } catch (err) {
    setProvStatus(
      `Couldn't list models: ${(err as Error).message}. You can still type the id.`,
      true,
    );
  } finally {
    provFind.disabled = false;
  }
});

el("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  provSave.disabled = true;
  setProvStatus("Saving…");
  try {
    const res = await fetch("/api/provider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...destinationOf("prov"),
        model: provModel.value,
        // Left out keeps the key held for this address; null removes it.
        apiKey: provKey.value ? provKey.value : removeKey ? null : undefined,
      }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    state.provider = ((await res.json()) as { provider: ApiProvider }).provider;
    fillSettings();
    setProvStatus(
      `Saved. Documents are now processed by ${state.provider.model}.`,
    );
    render();
  } catch (err) {
    setProvStatus((err as Error).message, true);
  } finally {
    provSave.disabled = false;
  }
});

provClear.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/provider", { method: "DELETE" });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    state.provider = null;
    fillSettings();
    setProvStatus("Cleared. New documents will wait to be processed.");
    render();
  } catch (err) {
    setProvStatus((err as Error).message, true);
  }
});

provWaiting.addEventListener("click", (e) => {
  if (!(e.target instanceof Element) || !e.target.closest("#prov-read")) return;
  settings.close();
  readWaiting();
});

// ---- Settings: Reading languages -------------------------------------------
// The offered languages, by name: the tested ones first, the rest offered
// without that promise. Saving reads nothing again, but which of each
// Document's titles is shown may change, so the Library is fetched anew.

const langPicks = [1, 2, 3, 4].map((n) => el<HTMLSelectElement>(`lang-${n}`));
const langStatus = el("lang-status");
const langSave = el<HTMLButtonElement>("lang-save");

function setLangStatus(msg: string, isErr = false) {
  langStatus.textContent = msg;
  langStatus.classList.toggle("err", isErr);
}

/** The options every picker offers: the tested ones first, in their own order, then the rest by name. */
function languageOptions(): Html {
  const option = (code: string) =>
    html`<option value="${code}">${languageName(code)}</option>`;
  const byName = (a: string, b: string) =>
    languageName(a).localeCompare(languageName(b));
  const untested = OFFERED_LANGUAGES.filter(
    (c) => !TESTED_LANGUAGES.includes(c),
  ).sort(byName);
  return html`<optgroup label="Tested">${TESTED_LANGUAGES.map(option)}</optgroup><optgroup label="Untested">${untested.map(option)}</optgroup>`;
}

/** Offer every language in these pickers, the first one required. */
function fillLanguagePickers(picks: HTMLSelectElement[]) {
  const options = languageOptions();
  picks.forEach((pick, i) => {
    setHtml(
      pick,
      html`${i > 0 && html`<option value="">None</option>`}${options}`,
    );
  });
}

fillLanguagePickers(langPicks);

/**
 * Set the pickers to these languages. One the pickers don't offer (chosen
 * through the API) is added where it is held, so saving never drops it.
 */
function showLanguages(languages: string[]) {
  langPicks.forEach((pick, i) => {
    const code = languages[i] ?? "";
    if (code && ![...pick.options].some((o) => o.value === code))
      pick.add(new Option(languageName(code), code));
    pick.value = code;
  });
}

/** Draw the pickers from the user's Reading languages, as the server holds them. */
async function fillLanguages() {
  setLangStatus("");
  try {
    const res = await fetch("/api/reading-languages");
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    const { languages } = (await res.json()) as { languages: string[] };
    showLanguages(languages);
  } catch (err) {
    setLangStatus(
      `Couldn't read your languages: ${(err as Error).message}`,
      true,
    );
  }
}

el("lang-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const languages = langPicks.map((pick) => pick.value).filter(Boolean);
  langSave.disabled = true;
  setLangStatus("Saving…");
  try {
    const res = await fetch("/api/reading-languages", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ languages }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    const saved = (await res.json()) as { languages: string[] };
    showLanguages(saved.languages);
    setLangStatus(
      `Saved. Documents processed from now on are written in ${saved.languages.map(languageName).join(", ")}.`,
    );
    load();
  } catch (err) {
    setLangStatus((err as Error).message, true);
  } finally {
    langSave.disabled = false;
  }
});

// ---- Settings: the password ------------------------------------------------
// Adding one is a choice, never a demand. Changing one takes the current password, since a session alone could be a
// browser left signed in.

const pwIntro = el("pw-intro");
const pwCurrent = el<HTMLInputElement>("pw-current");
const pwNew = el<HTMLInputElement>("pw-new");
const pwStatus = el("pw-status");
const pwSave = el<HTMLButtonElement>("pw-save");

/** Whether the signed-in user has a password, as /api/auth/me last said. */
let hasPassword = false;

function setPwStatus(msg: string, isErr = false) {
  pwStatus.textContent = msg;
  pwStatus.classList.toggle("err", isErr);
}

function fillPassword() {
  pwIntro.textContent = hasPassword
    ? "Change the password you sign in with."
    : "Add a password to sign in where your passkey isn't available, such as over plain HTTP. At least 8 characters.";
  for (const node of document.querySelectorAll<HTMLElement>(".pw-current"))
    node.hidden = !hasPassword;
  pwCurrent.required = hasPassword;
  pwCurrent.value = "";
  pwNew.value = "";
  pwSave.textContent = hasPassword ? "Change password" : "Set password";
  setPwStatus("");
}

el("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  pwSave.disabled = true;
  setPwStatus("Saving…");
  try {
    const res = await fetch("/api/auth/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: pwNew.value,
        currentPassword: hasPassword ? pwCurrent.value : undefined,
      }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    const changed = hasPassword;
    hasPassword = true;
    fillPassword();
    setPwStatus(changed ? "Password changed." : "Password set.");
  } catch (err) {
    setPwStatus((err as Error).message, true);
  } finally {
    pwSave.disabled = false;
  }
});

// ---- Settings: a passkey ---------------------------------------------------
// An upgrade where WebAuthn works, added once signed in. The Library's owner
// comes from Setup with a password, so a passkey is never the only way to begin.

const passkeyForm = el<HTMLFormElement>("passkey-form");
const passkeyStatus = el("passkey-status");
const passkeyAdd = el<HTMLButtonElement>("passkey-add");
const passkeyRow = el("passkey-row");
const passkeyIntro = el("passkey-intro");

function setPasskeyStatus(msg: string, isErr = false) {
  passkeyStatus.textContent = msg;
  passkeyStatus.classList.toggle("err", isErr);
}

function fillPasskey() {
  // Over plain HTTP the browser has no passkeys at all, and the password form
  // already says so. Where it has them but the server isn't told its address,
  // say what's missing rather than offer a prompt that would fail.
  passkeyForm.hidden = !browserHasPasskeys();
  // With nothing to press there is nothing to report either, so the button's
  // row and the status line go too, leaving no gap under the intro.
  const works = passkeysWork();
  passkeyAdd.hidden = !works;
  passkeyStatus.hidden = !works;
  passkeyRow.hidden = !works;
  passkeyIntro.textContent = passkeysOffered
    ? "Sign in with this device's passkey instead of typing your password."
    : "Passkeys need the address Zayla is opened at. Set ZAYLA_URL on the server (for example https://docs.example.com) and restart it.";
  setPasskeyStatus("");
}

passkeyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  passkeyAdd.disabled = true;
  setPasskeyStatus("Waiting for your passkey…");
  try {
    await addPasskey();
    setPasskeyStatus("Passkey added. You can sign in with it from now on.");
  } catch (err) {
    // A cancelled WebAuthn prompt throws too: say so, and let them retry.
    setPasskeyStatus((err as Error).message || "Something went wrong.", true);
  } finally {
    passkeyAdd.disabled = false;
  }
});

// ---- Authentication (passwords and passkeys) ----
// The gate covers the app until a session is established. On load we probe
// /api/auth/me: authenticated → app; no users yet → Setup; otherwise → sign
// in with a password, or a passkey where WebAuthn works.

const gate = el("gate");
const gateBtn = el<HTMLButtonElement>("gate-btn");
const gateStatus = el("gate-status");
const gatePwForm = el<HTMLFormElement>("gate-pw-form");
const gatePw = el<HTMLInputElement>("gate-pw");
const gatePwBtn = el<HTMLButtonElement>("gate-pw-btn");
const logoutBtn = el<HTMLButtonElement>("logout-btn");

function setGateStatus(msg: string, isErr = false) {
  gateStatus.textContent = msg;
  gateStatus.classList.toggle("err", isErr);
}

/** Whether the server has passkeys configured, as /api/auth/me last said. */
let passkeysOffered = false;

/** Passkeys need WebAuthn, which browsers offer only on secure origins. */
function browserHasPasskeys() {
  return window.isSecureContext && "PublicKeyCredential" in window;
}

/** Passkeys work where the browser has them and the server knows its address. */
function passkeysWork() {
  return browserHasPasskeys() && passkeysOffered;
}

/** Cover the app: with Setup while the Library has nobody, else the sign-in gate. */
function showGate(needsSetup: boolean) {
  settingsBtn.hidden = true;
  logoutBtn.hidden = true;
  moreBtn.hidden = true;
  if (needsSetup) {
    gate.classList.remove("on");
    showSetup();
    return;
  }
  setup.classList.remove("on");
  gatePwForm.hidden = false;
  gatePw.value = "";
  gateBtn.hidden = !passkeysWork();
  setGateStatus("");
  gateBtn.disabled = false;
  gatePwBtn.disabled = false;
  gate.classList.add("on");
}

function enterApp() {
  gate.classList.remove("on");
  setup.classList.remove("on");
  logoutBtn.hidden = false;
  settingsBtn.hidden = false;
  moreBtn.hidden = false;
  load();
}

// Probe session state and route to the app, Setup or the sign-in gate.
async function refreshAuth() {
  try {
    const res = await fetch("/api/auth/me");
    const me = (await res.json()) as {
      authenticated: boolean;
      user: { hasPassword: boolean } | null;
      needsSetup: boolean;
      passkeysOffered: boolean;
    };
    hasPassword = me.user?.hasPassword ?? false;
    passkeysOffered = me.passkeysOffered;
    if (me.authenticated) enterApp();
    else showGate(me.needsSetup);
  } catch {
    gate.classList.add("on");
    setGateStatus("Couldn't reach the server.", true);
  }
}

/** Read `{ error }` from a failed JSON response, falling back to a default. */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error || fallback;
  } catch {
    return fallback;
  }
}

/** Add a passkey for the signed-in user. */
async function addPasskey() {
  const optRes = await fetch("/api/auth/register/options", { method: "POST" });
  if (!optRes.ok)
    throw new Error(await errorFrom(optRes, "couldn't start adding a passkey"));
  const optionsJSON = await optRes.json();
  const attResp = await startRegistration({ optionsJSON });
  const verifyRes = await fetch("/api/auth/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attResp),
  });
  if (!verifyRes.ok)
    throw new Error(await errorFrom(verifyRes, "verification failed"));
}

async function doLogin() {
  const optRes = await fetch("/api/auth/login/options", { method: "POST" });
  if (!optRes.ok) throw new Error(await errorFrom(optRes, "login unavailable"));
  const optionsJSON = await optRes.json();
  const authResp = await startAuthentication({ optionsJSON });
  const verifyRes = await fetch("/api/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authResp),
  });
  if (!verifyRes.ok)
    throw new Error(await errorFrom(verifyRes, "verification failed"));
}

gatePwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  gatePwBtn.disabled = true;
  setGateStatus("Signing in…");
  try {
    const res = await fetch("/api/auth/password/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: gatePw.value }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, "sign-in failed"));
    // Re-probe rather than enter directly, so Settings knows about the password.
    await refreshAuth();
  } catch (err) {
    setGateStatus((err as Error).message, true);
    gatePwBtn.disabled = false;
    gatePw.select();
  }
});

gateBtn.addEventListener("click", async () => {
  gateBtn.disabled = true;
  setGateStatus("Waiting for passkey…");
  try {
    await doLogin();
    await refreshAuth();
  } catch (err) {
    // A user-cancelled WebAuthn prompt throws too — surface it, let them retry.
    setGateStatus((err as Error).message || "Something went wrong.", true);
    gateBtn.disabled = false;
  }
});

// ---- Setup -----------------------------------------------------------------
// A Library with no user opens here: the code from the server's logs, then a
// password, then Reading languages, then a Provider, which can be skipped.
// Nothing is created until the last step, and then all of it at once.

const setup = el("setup");
const setupStatus = el("setup-status");
const setupSteps = [
  "setup-code-form",
  "setup-pw-form",
  "setup-lang-form",
  "setup-prov-form",
].map((id) => el<HTMLFormElement>(id));
const setupCode = el<HTMLInputElement>("setup-code");
const setupPw = el<HTMLInputElement>("setup-pw");
const setupPwAgain = el<HTMLInputElement>("setup-pw-again");
const setupLangPicks = [1, 2, 3, 4].map((n) =>
  el<HTMLSelectElement>(`setup-lang-${n}`),
);
const setupProvKey = el<HTMLInputElement>("setup-prov-key");
const setupProvModel = el<HTMLInputElement>("setup-prov-model");
const setupProvModels = el<HTMLDataListElement>("setup-prov-models");
const setupProvFind = el<HTMLButtonElement>("setup-prov-find");

/** The code as accepted by the server, carried by every later step. */
let acceptedCode = "";

function setSetupStatus(msg: string, isErr = false) {
  setupStatus.textContent = msg;
  setupStatus.classList.toggle("err", isErr);
}

function showStep(n: number) {
  setupSteps.forEach((form, i) => {
    form.hidden = i !== n;
  });
  setSetupStatus("");
  setupSteps[n]?.querySelector<HTMLElement>("input, select")?.focus();
}

/** The browser's language when it is a tested one, else English. */
function browserReadingLanguage(): string {
  const code = (navigator.language.split("-")[0] ?? "").toUpperCase();
  return TESTED_LANGUAGES.includes(code) ? code : "EN";
}

fillLanguagePickers(setupLangPicks);

function showSetup() {
  acceptedCode = "";
  setupLangPicks.forEach((pick, i) => {
    pick.value = i === 0 ? browserReadingLanguage() : "";
  });
  setup.classList.add("on");
  showStep(0);
}

for (const back of setup.querySelectorAll<HTMLButtonElement>(".setup-back"))
  back.addEventListener("click", () => {
    const at = setupSteps.findIndex((form) => !form.hidden);
    showStep(Math.max(0, at - 1));
  });

/** Disable a step's buttons while it waits for the server. */
function setBusy(form: HTMLFormElement, on: boolean) {
  for (const b of form.querySelectorAll("button")) b.disabled = on;
}

setupSteps[0]?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  setBusy(form, true);
  setSetupStatus("Checking…");
  try {
    const res = await fetch("/api/setup/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: setupCode.value }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, "that code didn't work"));
    acceptedCode = setupCode.value;
    showStep(1);
  } catch (err) {
    setSetupStatus((err as Error).message, true);
    setupCode.select();
  } finally {
    setBusy(form, false);
  }
});

setupSteps[1]?.addEventListener("submit", (e) => {
  e.preventDefault();
  // The server's rule, counted as it counts: by character, not UTF-16 unit.
  if ([...setupPw.value].length < 8) {
    setSetupStatus("A password needs at least 8 characters.", true);
    setupPw.select();
    return;
  }
  if (setupPw.value !== setupPwAgain.value) {
    setSetupStatus("The two passwords aren't the same.", true);
    setupPwAgain.select();
    return;
  }
  showStep(2);
});

setupSteps[2]?.addEventListener("submit", (e) => {
  e.preventDefault();
  showStep(3);
});

showKind("setup-prov", "openrouter");
setupSteps[3]?.querySelector(".prov-kind")?.addEventListener("change", () => {
  const kind = chosenKind("setup-prov");
  showKind("setup-prov", kind);
  setupProvKey.placeholder = noKeyHint(kind);
  setupProvModels.replaceChildren();
  setSetupStatus("");
});
el("setup-prov-zero-retention").addEventListener("change", () => {
  setupProvModels.replaceChildren();
  setSetupStatus("");
});

setupProvFind.addEventListener("click", async () => {
  const destination = destinationOf("setup-prov");
  if (destination.kind === "custom" && !destination.baseUrl) {
    setSetupStatus("Enter the address first.", true);
    return;
  }
  setupProvFind.disabled = true;
  setSetupStatus("Asking for models…");
  try {
    const res = await fetch("/api/setup/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: acceptedCode,
        ...destination,
        apiKey: setupProvKey.value || undefined,
      }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, `HTTP ${res.status}`));
    const { models } = (await res.json()) as { models: string[] };
    setSetupStatus(offerModels(setupProvModels, models));
    if (models.length) setupProvModel.focus();
  } catch (err) {
    setSetupStatus(
      `Couldn't list models: ${(err as Error).message}. You can still type the id.`,
      true,
    );
  } finally {
    setupProvFind.disabled = false;
  }
});

/** Create the owner with everything chosen, and sign them in. */
async function finishSetup(
  provider:
    | (ReturnType<typeof destinationOf> & { model: string; apiKey?: string })
    | null,
) {
  const form = setupSteps[3];
  if (form) setBusy(form, true);
  setSetupStatus("Setting up your library…");
  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: acceptedCode,
        password: setupPw.value,
        languages: setupLangPicks.map((pick) => pick.value).filter(Boolean),
        provider,
      }),
    });
    if (res.status === 403) {
      // The code went stale (the server restarted) or Setup is over: start
      // again from the code, where the reason makes sense.
      const why = await errorFrom(res, "Setup failed");
      showStep(0);
      setSetupStatus(why, true);
      return;
    }
    if (!res.ok) throw new Error(await errorFrom(res, "Setup failed"));
    setupPw.value = "";
    setupPwAgain.value = "";
    await refreshAuth();
  } catch (err) {
    setSetupStatus((err as Error).message, true);
  } finally {
    if (form) setBusy(form, false);
  }
}

setupSteps[3]?.addEventListener("submit", (e) => {
  e.preventDefault();
  finishSetup({
    ...destinationOf("setup-prov"),
    model: setupProvModel.value,
    apiKey: setupProvKey.value || undefined,
  });
});
el("setup-skip").addEventListener("click", () => finishSetup(null));

async function signOut() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Even if the request fails, drop back to the gate; the cookie may linger
    // but the next protected call will 401.
  }
  showGate(false);
}

logoutBtn.addEventListener("click", signOut);
el("more-logout").addEventListener("click", () => {
  closeMoreMenu(false);
  signOut();
});

// The sidebar is drawn before the session is known, so the shell is whole behind
// the gate. The view itself waits for `load`.
renderNav();
refreshAuth();
