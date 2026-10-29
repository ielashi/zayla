import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { Party } from "../shared.ts";
import { clearAllAuth, createUser } from "./auth.ts";
import type { Library } from "./db.ts";
import {
  type CatalogFields,
  closeLibrary,
  deleteDocument,
  insertDocument,
  openLibrary,
  updateEnrichment,
} from "./db.ts";
import {
  entityDetail,
  listEntities,
  markedAsMe,
  markMe,
  mergeEntities,
  suggestDuplicates,
} from "./entities.ts";

const TMP = `/tmp/dm-entities-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const doc = (hash: string): CatalogFields => ({
  hash,
  ext: "pdf",
  mime: "application/pdf",
  filename: `${hash}.pdf`,
  bytes: 1,
  status: "imported",
  addedAt: new Date().toISOString(),
});

/** Catalog a Document, if it isn't yet, and Enrich it with a reading naming these parties. */
function read(
  lib: Library,
  hash: string,
  reading: { sender?: Party; receiver?: Party; people?: string[] },
): void {
  insertDocument(lib, doc(hash));
  const nobody = { organization: "", person: "" };
  updateEnrichment(
    lib,
    hash,
    {
      texts: {},
      people: reading.people ?? [],
      sender: reading.sender ?? nobody,
      receiver: reading.receiver ?? nobody,
      deadlines: [],
      date: null,
      languages: [],
      keywords: [],
      ref: [],
    },
    { textSource: "vision", baseUrl: "http://mock.test/v1", model: "mock" },
  );
}

const named = (lib: Library, displayName: string) =>
  listEntities(lib).find((e) => e.displayName === displayName);

test("a name seen again under another spelling is the same entity", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "bbb", { sender: { organization: "stadt  porto", person: "" } });

    const listed = listEntities(lib);
    expect(listed.length).toBe(1);
    expect(listed[0]?.displayName).toBe("Stadt Porto"); // the spelling first seen
    expect(listed[0]?.documents).toBe(2);
  } finally {
    closeLibrary(lib);
  }
});

test("an unseen name starts an entity of its own", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "bbb", { sender: { organization: "Region Osaka", person: "" } });

    expect(listEntities(lib).map((e) => e.displayName)).toEqual([
      "Region Osaka",
      "Stadt Porto",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Person and an Organization of the same name are two entities", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Okafor", person: "Okafor" },
    });

    expect(
      listEntities(lib)
        .map((e) => e.kind)
        .sort(),
    ).toEqual(["organization", "person"]);
  } finally {
    closeLibrary(lib);
  }
});

test("reading a Document again replaces its Appearances rather than adding to them", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "A. Keller" },
    });

    expect(named(lib, "Stadt Porto")?.documents).toBe(1);
    // The Person the second reading dropped keeps her name but no Appearance.
    expect(named(lib, "M. Schmidt")).toBeUndefined();
    expect(named(lib, "A. Keller")?.documents).toBe(1);
  } finally {
    closeLibrary(lib);
  }
});

test("a Document is counted once however many roles a name played in it", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "", person: "Jordan Okafor" },
      receiver: { organization: "", person: "Jordan Okafor" },
    });

    const jordan = named(lib, "Jordan Okafor");
    expect(jordan?.documents).toBe(1);
    expect(jordan?.roles).toEqual(["sender", "receiver"]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Person's listing shows the Organizations they appeared for", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    read(lib, "bbb", {
      sender: { organization: "Region Osaka", person: "M. Schmidt" },
    });

    const schmidt = named(lib, "M. Schmidt");
    expect(schmidt?.documents).toBe(2);
    expect(schmidt?.affiliations.map((a) => a.displayName)).toEqual([
      "Region Osaka",
      "Stadt Porto",
    ]);
    // Identified, not merely named: the id is what nests a Person under the
    // Organization they acted for.
    expect(schmidt?.affiliations.map((a) => a.id)).toEqual([
      named(lib, "Region Osaka")?.id as number,
      named(lib, "Stadt Porto")?.id as number,
    ]);
    // The affiliation belongs to the Appearance, not to the Organization.
    expect(named(lib, "Stadt Porto")?.affiliations).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("a name merely named in a Document appears as mentioned", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { people: ["Jana Okafor"] });

    expect(named(lib, "Jana Okafor")?.roles).toEqual(["mentioned"]);
  } finally {
    closeLibrary(lib);
  }
});

test("the listing puts the entities with the most Documents first", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "bbb", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "ccc", { sender: { organization: "Region Osaka", person: "" } });

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Stadt Porto", 2],
      ["Region Osaka", 1],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity left with no Documents is not listed", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    deleteDocument(lib, "aaa");

    expect(listEntities(lib)).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("a name variant outlives the Document it was learned from", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const before = named(lib, "Stadt Porto")?.id;
    deleteDocument(lib, "aaa");

    read(lib, "bbb", { sender: { organization: "STADT PORTO", person: "" } });

    expect(named(lib, "Stadt Porto")?.id).toBe(before as number);
  } finally {
    closeLibrary(lib);
  }
});

test("an absent party leaves no 'unknown' standing in for it", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "" },
      receiver: { organization: "unknown", person: "N/A" },
    });

    expect(listEntities(lib).map((e) => e.displayName)).toEqual([
      "Stadt Porto",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("two spellings that look like one name are suggested as one entity", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "", person: "Jordan Okafor" } });
    read(lib, "bbb", {
      sender: { organization: "", person: "Okafor, Jordan" },
    });

    const suggested = suggestDuplicates(listEntities(lib));
    expect(suggested.map((s) => s.entities.map((e) => e.displayName))).toEqual([
      ["Jordan Okafor", "Okafor, Jordan"],
    ]);
    expect(suggested[0]?.kind).toBe("person");
  } finally {
    closeLibrary(lib);
  }
});

test("a suggestion merges nothing: both entities keep their own Documents", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "", person: "Jordan Okafor" } });
    read(lib, "bbb", { sender: { organization: "", person: "J. Okafor" } });
    read(lib, "ccc", { sender: { organization: "", person: "J. Okafor" } });

    expect(suggestDuplicates(listEntities(lib)).length).toBe(1);

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["J. Okafor", 2],
      ["Jordan Okafor", 1],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("the entity with more Documents is suggested first", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "", person: "J. Okafor" } });
    read(lib, "bbb", { sender: { organization: "", person: "J. Okafor" } });
    read(lib, "ccc", { sender: { organization: "", person: "Jordan Okafor" } });

    expect(
      suggestDuplicates(listEntities(lib)).map((s) =>
        s.entities.map((e) => e.displayName),
      ),
    ).toEqual([["J. Okafor", "Jordan Okafor"]]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Person and an Organization of the same name are not suggested as one", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Okafor", person: "Okafor" } });

    expect(suggestDuplicates(listEntities(lib))).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("two different people sharing a surname are not suggested as one", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "", person: "Jordan Okafor" } });
    read(lib, "bbb", { sender: { organization: "", person: "Jana Okafor" } });

    expect(suggestDuplicates(listEntities(lib))).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity left with no Documents is not suggested", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "", person: "Jordan Okafor" } });
    read(lib, "bbb", {
      sender: { organization: "", person: "Okafor, Jordan" },
    });
    deleteDocument(lib, "bbb");

    expect(suggestDuplicates(listEntities(lib))).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

// ---- one entity's own page ------------------------------------------------

/** The page of the entity listed under this name, or a refusal if it has none. */
function pageOf(lib: Library, displayName: string) {
  const listed = named(lib, displayName);
  if (!listed) throw new Error(`nothing listed as ${displayName}`);
  const detail = entityDetail(lib, listed.id);
  if (!detail) throw new Error(`${displayName} is listed but has no page`);
  return detail;
}

test("an entity's page carries what the lists say about it", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    read(lib, "bbb", { sender: { organization: "Stadt Porto", person: "" } });

    const stadt = pageOf(lib, "Stadt Porto");
    expect(stadt.kind).toBe("organization");
    expect(stadt.documents).toBe(2);
    expect(stadt.affiliations).toEqual([]);

    const schmidt = pageOf(lib, "M. Schmidt");
    expect(schmidt.kind).toBe("person");
    expect(schmidt.documents).toBe(1);
    // For a Person, the Organizations she appeared for.
    expect(schmidt.affiliations.map((a) => a.displayName)).toEqual([
      "Stadt Porto",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity's page lists the spellings it has been written as", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "bbb", { sender: { organization: "Stadt  PORTO", person: "" } });

    // Two ways of writing one spelling are one spelling: the second Document
    // resolved to the name the first taught, and taught nothing new.
    expect(pageOf(lib, "Stadt Porto").variants).toEqual(["Stadt Porto"]);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity's page groups its Documents by the part it played", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "bbb", { sender: { organization: "Stadt Porto", person: "" } });
    read(lib, "ccc", { receiver: { organization: "Stadt Porto", person: "" } });
    read(lib, "ddd", { people: ["Jordan Okafor"] });
    read(lib, "eee", {
      sender: { organization: "Region Osaka", person: "" },
      receiver: { organization: "Stadt Porto", person: "" },
    });

    expect(pageOf(lib, "Stadt Porto").documentsByRole).toEqual([
      { role: "sender", hashes: ["aaa", "bbb"] },
      { role: "receiver", hashes: ["ccc", "eee"] },
    ]);
    // A part it never played is absent rather than empty.
    expect(pageOf(lib, "Jordan Okafor").documentsByRole).toEqual([
      { role: "mentioned", hashes: ["ddd"] },
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Document an entity was both parties to is under the more prominent part", () => {
  const lib = openLibrary(TMP);
  try {
    // Writing to itself: one Document, and what it sent is what it is.
    read(lib, "aaa", {
      sender: { organization: "Stadt Porto", person: "" },
      receiver: { organization: "Stadt Porto", person: "" },
    });

    const stadt = pageOf(lib, "Stadt Porto");
    expect(stadt.documentsByRole).toEqual([
      { role: "sender", hashes: ["aaa"] },
    ]);
    // Which is what keeps the groups adding up to the count the lists show.
    expect(stadt.documents).toBe(1);
  } finally {
    closeLibrary(lib);
  }
});

test("the groups on an entity's page account for each of its Documents once", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "", person: "Jordan Okafor" },
      receiver: { organization: "", person: "Jordan Okafor" },
      people: ["Jordan Okafor"],
    });
    read(lib, "bbb", {
      receiver: { organization: "", person: "Jordan Okafor" },
    });
    read(lib, "ccc", { people: ["Jordan Okafor"] });

    const okafor = pageOf(lib, "Jordan Okafor");
    const grouped = okafor.documentsByRole.flatMap((g) => g.hashes);
    expect(grouped.length).toBe(okafor.documents);
    expect(new Set(grouped).size).toBe(okafor.documents);
  } finally {
    closeLibrary(lib);
  }
});

test("a merged name's spellings and Documents are on the surviving name's page", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Acme Foundation", person: "" },
    });
    read(lib, "bbb", {
      sender: { organization: "Acme Foundation", person: "" },
    });
    read(lib, "ccc", {
      receiver: { organization: "Acme Stiftung", person: "" },
    });
    mergeEntities(
      lib,
      named(lib, "Acme Foundation")?.id ?? 0,
      named(lib, "Acme Stiftung")?.id ?? 0,
    );

    const page = pageOf(lib, "Acme Foundation");
    expect(page.documents).toBe(3);
    expect(page.variants).toEqual(["Acme Foundation", "Acme Stiftung"]);
    expect(page.documentsByRole).toEqual([
      { role: "sender", hashes: ["aaa", "bbb"] },
      { role: "receiver", hashes: ["ccc"] },
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a merged-away name's address answers with the page that answers for it", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", {
      sender: { organization: "Acme Foundation", person: "" },
    });
    read(lib, "bbb", { sender: { organization: "Acme Stiftung", person: "" } });
    const { survivor, absorbed } = mergeEntities(
      lib,
      named(lib, "Acme Foundation")?.id ?? 0,
      named(lib, "Acme Stiftung")?.id ?? 0,
    );

    // The spelling the owner merged away is still a bookmark worth honouring:
    // it answers with the name that answers for it now, as every read does.
    expect(entityDetail(lib, absorbed.id)?.id).toBe(survivor.id);
  } finally {
    closeLibrary(lib);
  }
});

test("an id that is nobody's, and a name with nothing left to browse, have no page", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { sender: { organization: "Stadt Porto", person: "" } });
    const stadt = named(lib, "Stadt Porto");
    expect(entityDetail(lib, 9999)).toBe(null);

    deleteDocument(lib, "aaa");
    expect(entityDetail(lib, stadt?.id ?? 0)).toBe(null);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity's page puts the names that look like its own to the owner", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { people: ["Jordan Okafor"] });
    read(lib, "bbb", { people: ["Jordan Okafor"] });
    read(lib, "ccc", { people: ["J. Okafor"] });
    read(lib, "ddd", { people: ["Jana Okafor"] });

    // Seen from either side, and with the count that says which spelling the
    // Library leans on.
    expect(
      pageOf(lib, "Jordan Okafor").suspected.map((e) => [
        e.displayName,
        e.documents,
      ]),
    ).toEqual([["J. Okafor", 1]]);
    // An initial can stand for either given name, so the owner is asked about
    // both rather than told which: one spelling may look like two names, and
    // which of them it is is exactly what only the owner knows.
    expect(
      pageOf(lib, "J. Okafor").suspected.map((e) => e.displayName),
    ).toEqual(["Jordan Okafor", "Jana Okafor"]);
    // Two people who merely share a surname are not put to the owner at all.
    expect(
      pageOf(lib, "Jana Okafor").suspected.map((e) => e.displayName),
    ).toEqual(["J. Okafor"]);
  } finally {
    closeLibrary(lib);
  }
});

test("a name merged away is no longer put to the owner as a look-alike", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { people: ["Jordan Okafor"] });
    read(lib, "bbb", { people: ["J. Okafor"] });
    mergeEntities(
      lib,
      named(lib, "Jordan Okafor")?.id ?? 0,
      named(lib, "J. Okafor")?.id ?? 0,
    );

    // The question has been answered, so it is not asked again: the absorbed
    // name is not listed, and the surviving page names it as a Merge instead.
    const page = pageOf(lib, "Jordan Okafor");
    expect(page.suspected).toEqual([]);
    expect(page.mergedNames.map((m) => m.displayName)).toEqual(["J. Okafor"]);
  } finally {
    closeLibrary(lib);
  }
});

// ---- the Person a user has marked as Me -----------------------------------

test("resetting the users forgets who each of them had marked as Me", () => {
  const lib = openLibrary(TMP);
  try {
    read(lib, "aaa", { people: ["Jordan Okafor"] });
    const okafor = named(lib, "Jordan Okafor")?.id ?? 0;
    const one = createUser(lib, "one", null).id;
    const two = createUser(lib, "two", null).id;
    markMe(lib, one, okafor);
    markMe(lib, two, okafor);
    expect(markedAsMe(lib, one)).toBe(okafor);

    // The escape hatch that removes the users: a mark is one user's statement,
    // so it goes with them rather than waiting for the id to come round again.
    clearAllAuth(lib);

    expect(markedAsMe(lib, one)).toBe(null);
    expect(markedAsMe(lib, two)).toBe(null);
    // And the Person herself is untouched, Documents, name and all.
    expect(named(lib, "Jordan Okafor")?.documents).toBe(1);
  } finally {
    closeLibrary(lib);
  }
});
