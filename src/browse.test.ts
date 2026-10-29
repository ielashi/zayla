import { expect, test } from "bun:test";
import {
  type Browsable,
  browseView,
  listedEntities,
  SHORTCUT_LIMIT,
} from "./browse.ts";
import { resolveRoute } from "./routes.ts";

/** An Organization as `listEntities` returns it, with only what browsing reads. */
const org = (
  id: number,
  displayName: string,
  documents: number,
): Browsable => ({
  id,
  kind: "organization",
  displayName,
  documents,
  affiliations: [],
});

/** A Person, affiliated to the Organizations given — any of them by name and id. */
const person = (
  id: number,
  displayName: string,
  documents: number,
  ...affiliations: { id: number; displayName: string }[]
): Browsable => ({
  id,
  kind: "person",
  displayName,
  documents,
  affiliations: affiliations.map((a) => ({
    id: a.id,
    displayName: a.displayName,
  })),
});

const names = (list: { displayName: string }[]) =>
  list.map((e) => e.displayName);

test("Organizations are the spine, each carrying the People who appeared for it", () => {
  const stadt = org(1, "Stadt Porto", 3);
  const kanton = org(2, "Region Osaka", 1);
  const view = browseView([
    stadt,
    kanton,
    person(3, "M. Schmidt", 2, stadt),
    person(4, "A. Keller", 1, kanton),
  ]);

  expect(names(view.organizations)).toEqual(["Stadt Porto", "Region Osaka"]);
  expect(names(view.organizations[0]?.people ?? [])).toEqual(["M. Schmidt"]);
  expect(names(view.organizations[1]?.people ?? [])).toEqual(["A. Keller"]);
});

test("a Person who appeared for two Organizations is listed under each, once and with one count", () => {
  const stadt = org(1, "Stadt Porto", 2);
  const kanton = org(2, "Region Osaka", 2);
  const view = browseView([
    stadt,
    kanton,
    person(3, "M. Schmidt", 2, stadt, kanton),
  ]);

  for (const organization of view.organizations) {
    expect(organization.people).toEqual([
      { id: 3, displayName: "M. Schmidt", documents: 2 },
    ]);
  }
  // One entity with one count, not one entry per Organization.
  expect(view.people).toEqual([]);
});

test("the People belonging to no Organization are listed on their own", () => {
  const stadt = org(1, "Stadt Porto", 1);
  const view = browseView([
    stadt,
    person(2, "M. Schmidt", 1, stadt),
    person(3, "Jordan Okafor", 4),
    person(4, "Jana Okafor", 2),
  ]);

  // Only the unaffiliated, and not repeated from under an Organization.
  expect(names(view.people)).toEqual(["Jordan Okafor", "Jana Okafor"]);
});

test("an Organization nobody appeared for still lists, with no People under it", () => {
  const view = browseView([org(1, "Stadt Porto", 2)]);

  expect(names(view.organizations)).toEqual(["Stadt Porto"]);
  expect(view.organizations[0]?.people).toEqual([]);
});

test("a Person whose Organization is not itself listed falls back to the People", () => {
  // Today's derivation cannot produce this: an affiliation is only ever taken
  // from a party whose Organization is recorded as appearing in the same
  // Document, so an affiliating Organization is always listed. This pins the
  // net under that invariant — were it ever to break, she must still have a row
  // somewhere rather than silently leaving the Library's account of who it
  // involves. See the note on `shownUnder` in browse.ts.
  const view = browseView([
    person(2, "M. Schmidt", 1, { id: 99, displayName: "Unlisted" }),
  ]);

  expect(view.organizations).toEqual([]);
  expect(names(view.people)).toEqual(["M. Schmidt"]);
});

test("both lists put the most Documents first and order equals alphabetically", () => {
  const stadt = org(1, "Stadt Porto", 1);
  const kanton = org(2, "Region Osaka", 1);
  const view = browseView([
    person(5, "zoe Keller", 1),
    person(3, "Jordan Okafor", 2),
    kanton,
    person(4, "Ada Keller", 1),
    stadt,
    person(6, "Bea Weber", 1, stadt),
    person(7, "Al Weber", 1, stadt),
  ]);

  expect(names(view.organizations)).toEqual(["Region Osaka", "Stadt Porto"]);
  expect(names(view.organizations[1]?.people ?? [])).toEqual([
    "Al Weber",
    "Bea Weber",
  ]);
  expect(names(view.people)).toEqual([
    "Jordan Okafor",
    "Ada Keller",
    "zoe Keller",
  ]);
});

test("an entity with no remaining Documents appears in neither list", () => {
  // The entities to list already exclude them; browsing revives none.
  expect(browseView([])).toEqual({
    organizations: [],
    people: [],
    shortcuts: [],
    duplicates: [],
    me: null,
  });
});

test("nobody is Me until a Person is marked", () => {
  expect(browseView([person(2, "M. Schmidt", 1)]).me).toBe(null);
});

test("the Person marked as Me heads the People and is named by the view", () => {
  const view = browseView(
    [person(3, "Jordan Okafor", 4), person(4, "Jana Okafor", 9)],
    [],
    3,
  );

  // Ahead of a Person with more Documents: the reader's own row is the one row
  // the lists are not ordered by presence, because it is the reader's.
  expect(names(view.people)).toEqual(["Jordan Okafor", "Jana Okafor"]);
  expect(view.me).toBe(3);
});

test("the Person marked as Me is among the People even where she appeared for an Organization", () => {
  const stadt = org(1, "Stadt Porto", 5);
  const view = browseView(
    [stadt, person(2, "M. Schmidt", 2, stadt), person(3, "Jana Okafor", 1)],
    [],
    2,
  );

  // Still under the Organization she acted for — one entity shown in two
  // places, as a Person affiliated to two already is — and at the head of the
  // People, where "addressed to me" is a distinction that can be browsed.
  expect(names(view.organizations[0]?.people ?? [])).toEqual(["M. Schmidt"]);
  expect(names(view.people)).toEqual(["M. Schmidt", "Jana Okafor"]);
});

test("a Person marked as Me whose Documents are all gone is named but not listed", () => {
  // Her entity outlives her paperwork, and the mark with it, but the lists show
  // the Library rather than its history: she is still Me, with no row anywhere
  // and nothing invented for her at the head of the People.
  const deleted = 3;
  const view = browseView([person(2, "M. Schmidt", 1)], [], deleted);

  expect(names(view.people)).toEqual(["M. Schmidt"]);
  expect(view.me).toBe(deleted);
});

test("a shortcut is offered to every entity the Library holds a Document for", () => {
  // No threshold: one Document is enough to be worth a shortcut, so the sidebar
  // fills in from the first Document a Library is given rather than staying
  // empty until some entity has accumulated enough paperwork.
  const view = browseView([
    org(1, "Often", 3),
    org(2, "Seldom", 2),
    person(3, "Frequent", 9),
    person(4, "Once", 1),
  ]);

  expect(names(view.shortcuts)).toEqual([
    "Frequent",
    "Often",
    "Seldom",
    "Once",
  ]);
});

test("the shortcuts are capped, most Documents first and alphabetically among equals", () => {
  expect(SHORTCUT_LIMIT).toBe(5);
  const view = browseView([
    org(1, "Delta", 4),
    org(2, "Bravo", 4),
    org(3, "Charlie", 9),
    org(4, "Echo", 3),
    org(5, "alfa", 3),
    org(6, "Foxtrot", 3),
    org(7, "Golf", 3),
  ]);

  expect(names(view.shortcuts)).toEqual([
    "Charlie",
    "Bravo",
    "Delta",
    "alfa",
    "Echo",
  ]);
  expect(view.shortcuts.length).toBe(SHORTCUT_LIMIT);
});

test("a shortcut addresses the entity's own page", () => {
  const stadt = org(1, "Stadt Porto", 5);
  const view = browseView([
    stadt,
    person(2, "M. Schmidt", 4, stadt),
    person(3, "Jordan Okafor", 3),
  ]);

  expect(view.shortcuts.map((s) => [s.displayName, s.path])).toEqual([
    ["Stadt Porto", "/organizations/1"],
    // Her own page, wherever in the lists she is a row: the shortcut is a way
    // to the Person, not to where she is listed.
    ["M. Schmidt", "/people/2"],
    ["Jordan Okafor", "/people/3"],
  ]);
});

test("every shortcut addresses the page of the entity it names", () => {
  const stadt = org(1, "Stadt Porto", 7);
  const kanton = org(2, "Region Osaka", 3);
  const view = browseView([
    stadt,
    kanton,
    person(3, "M. Schmidt", 6, stadt, kanton),
    person(4, "Jordan Okafor", 4),
    person(5, "Jana Okafor", 3, { id: 99, displayName: "Unlisted" }),
  ]);

  expect(view.shortcuts.length).toBe(SHORTCUT_LIMIT);
  for (const shortcut of view.shortcuts) {
    expect(resolveRoute(shortcut.path)).toEqual({
      at: "entity",
      kind: shortcut.path.startsWith("/organizations")
        ? "organization"
        : "person",
      id: shortcut.id,
    });
  }
});

test("the lists carry the pairs that look like one name, counted as the rows are", () => {
  const jordan = person(1, "Jordan Okafor", 2);
  const initial = person(2, "J. Okafor", 1);
  const view = browseView(
    [jordan, initial],
    [{ kind: "person", entities: [jordan, initial] }],
  );

  expect(view.duplicates).toEqual([
    {
      kind: "person",
      entities: [
        { id: 1, displayName: "Jordan Okafor", documents: 2 },
        { id: 2, displayName: "J. Okafor", documents: 1 },
      ],
    },
  ]);
  // Flagging a pair does not move it: both are listed exactly as before.
  expect(names(view.people)).toEqual(["Jordan Okafor", "J. Okafor"]);
});

test("nothing is flagged unless the Library's own listing says so", () => {
  const jordan = person(1, "Jordan Okafor", 2);
  expect(browseView([jordan]).duplicates).toEqual([]);
});

test("every entity of one kind can be picked, wherever the lists have it", () => {
  const stadt = org(1, "Stadt Porto", 5);
  const kanton = org(2, "Region Osaka", 3);
  const view = browseView([
    stadt,
    kanton,
    // A Person under two Organizations is one Person, so she can be picked
    // once; one belonging to none is pickable just the same.
    person(3, "M. Schmidt", 4, stadt, kanton),
    person(4, "Jordan Okafor", 2),
  ]);

  expect(names(listedEntities(view, "organization"))).toEqual([
    "Stadt Porto",
    "Region Osaka",
  ]);
  expect(names(listedEntities(view, "person"))).toEqual([
    "M. Schmidt",
    "Jordan Okafor",
  ]);
});
