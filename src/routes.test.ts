import { expect, test } from "bun:test";
import {
  DESTINATION_PATHS,
  DESTINATIONS,
  destination,
  ENTITY_PATH_PATTERNS,
  entityId,
  entityPath,
  resolveRoute,
} from "./routes.ts";

test("the root path is the Document view", () => {
  expect(resolveRoute("/")).toEqual({ at: "documents" });
});

test("each destination's path resolves to that destination", () => {
  for (const d of DESTINATIONS) {
    expect(resolveRoute(d.path)).toEqual({ at: d.name });
  }
});

test("an unrecognized path is not found, not the Document view", () => {
  expect(resolveRoute("/nope")).toEqual({ at: "not-found" });
  expect(resolveRoute("/documents")).toEqual({ at: "not-found" });
  expect(resolveRoute("")).toEqual({ at: "not-found" });
});

test("paths are matched exactly, as addresses are", () => {
  // Case and a trailing slash both make a different address, and only the
  // addresses the sidebar links are offered.
  expect(resolveRoute("/Organizations")).toEqual({ at: "not-found" });
  expect(resolveRoute("/organizations/")).toEqual({ at: "not-found" });
});

test("a mistyped data path is not found rather than a destination", () => {
  expect(resolveRoute("/api/documents")).toEqual({ at: "not-found" });
  expect(resolveRoute("/api/organisations")).toEqual({ at: "not-found" });
});

test("destination carries the path and the label the sidebar shows", () => {
  for (const d of DESTINATIONS) {
    expect(destination(d.name)).toEqual(d);
    expect(destination(d.name).label).not.toBe("");
    expect(resolveRoute(destination(d.name).path)).toEqual({ at: d.name });
  }
});

test("the paths the server must enumerate are exactly the destinations'", () => {
  expect([...DESTINATION_PATHS]).toEqual(DESTINATIONS.map((d) => d.path));
});

// ---- an entity's own page -------------------------------------------------

test("a path below a destination addresses one entity's page", () => {
  expect(resolveRoute("/organizations/12")).toEqual({
    at: "entity",
    kind: "organization",
    id: 12,
  });
  expect(resolveRoute("/people/3")).toEqual({
    at: "entity",
    kind: "person",
    id: 3,
  });
});

test("an entity's address is the path of the list that holds its kind", () => {
  expect(entityPath("organization", 12)).toBe("/organizations/12");
  expect(entityPath("person", 3)).toBe("/people/3");
  // And what it builds is what resolving reads back.
  for (const [kind, id] of [
    ["organization", 12],
    ["person", 3],
  ] as const) {
    expect(resolveRoute(entityPath(kind, id))).toEqual({
      at: "entity",
      kind,
      id,
    });
  }
});

test("the Document view has no entity pages below it", () => {
  expect(resolveRoute("/12")).toEqual({ at: "not-found" });
});

test("an entity's address names it by id, written one way only", () => {
  // A name, a padded number and anything below the page are all addresses of
  // nothing, so one entity has exactly one address.
  for (const path of [
    "/organizations/acme",
    "/organizations/012",
    "/organizations/0",
    "/organizations/-1",
    "/organizations/1.0",
    "/organizations/12/documents",
    "/people/",
  ]) {
    expect(resolveRoute(path)).toEqual({ at: "not-found" });
  }
});

test("entityId reads the entity a path segment names, and nothing else", () => {
  expect(entityId("12")).toBe(12);
  expect(entityId("1")).toBe(1);
  for (const segment of ["", "0", "012", "-1", "1.0", "1e3", " 1", "acme"]) {
    expect(entityId(segment)).toBe(null);
  }
});

test("the patterns the server registers are one per kind of entity", () => {
  expect([...ENTITY_PATH_PATTERNS]).toEqual([
    "/organizations/:id",
    "/people/:id",
  ]);
  // Every pattern belongs to a destination the sidebar offers, so an entity's
  // page is always below the list that holds it.
  for (const pattern of ENTITY_PATH_PATTERNS) {
    expect(DESTINATION_PATHS).toContain(pattern.replace("/:id", ""));
  }
});
