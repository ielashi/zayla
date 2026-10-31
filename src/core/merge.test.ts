import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "./db.ts";
import {
  type CatalogFields,
  closeLibrary,
  deleteDocument,
  getDocument,
  insertDocument,
  openLibrary,
} from "./db.ts";
import {
  type EnrichedMetadata,
  type EnrichmentProvider,
  enrichDocument,
} from "./enrich.ts";
import {
  findEntities,
  listEntities,
  MergeRefused,
  mergeEntities,
  suggestDuplicates,
  unmergeEntity,
} from "./entities.ts";
import { deleteFile, importFile } from "./ingest.ts";

const TMP = `/tmp/dm-merge-test-${process.pid}`;
const FIXDIR = `/tmp/dm-merge-fix-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
  await rm(FIXDIR, { recursive: true, force: true });
});

/** Metadata the reading tests don't care about; only the parties are asserted. */
const EMPTY_META: EnrichedMetadata = {
  texts: {},
  people: [],
  sender: { organization: "", person: "" },
  receiver: { organization: "", person: "" },
  deadlines: [],
  date: null,
  languages: [],
  keywords: [],
};

/** A hand-written provider whose reading names exactly these parties. */
const providerNaming = (
  parties: Partial<Pick<EnrichedMetadata, "sender" | "receiver" | "people">>,
): EnrichmentProvider => ({
  baseUrl: "http://mock.test/v1",
  model: "mock",
  async enrich() {
    return {
      meta: { ...EMPTY_META, ...parties },
      transcription: null,
      finishReason: "stop",
      costUsd: null,
    };
  },
});

const doc = (hash: string): CatalogFields => ({
  hash,
  ext: "pdf",
  mime: "application/pdf",
  filename: `${hash.slice(0, 6)}.pdf`,
  bytes: 1,
  status: "imported",
  addedAt: new Date().toISOString(),
});

/** Import a Document by hand and read it with a provider that names these parties. */
async function enrich(
  lib: Library,
  hash: string,
  parties: Partial<Pick<EnrichedMetadata, "sender" | "receiver" | "people">>,
): Promise<void> {
  insertDocument(lib, doc(hash));
  const record = getDocument(lib, hash);
  if (!record) throw new Error("expected the Document to be catalogued");
  await enrichDocument(lib, record, providerNaming(parties));
}

/** Sender a Document names, as the shorthand the tests below read in. */
const from = (person: string, organization = "") => ({
  sender: { organization, person },
});

const named = (lib: Library, displayName: string) =>
  listEntities(lib).find((e) => e.displayName === displayName);

const idOf = (lib: Library, displayName: string): number => {
  const entity = named(lib, displayName);
  if (!entity) throw new Error(`no entity displayed as ${displayName}`);
  return entity.id;
};

/** Read `count` Documents, each naming `person` as its sender. */
async function readSeveral(
  lib: Library,
  prefix: string,
  person: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++)
    await enrich(lib, `${prefix}${i}`.padEnd(64, "0"), from(person));
}

/** The same, with the Person acting for an Organization in each one. */
async function readSeveralFor(
  lib: Library,
  prefix: string,
  person: string,
  organization: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++)
    await enrich(
      lib,
      `${prefix}${i}`.padEnd(64, "0"),
      from(person, organization),
    );
}

// ---- Merging ------------------------------------------------------------

test("two spellings Merged are one entity with the Documents of both", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    expect(listEntities(lib).length).toBe(2);

    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 3],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("the surviving name is the most frequent variant, whichever order it is given in", async () => {
  for (const reversed of [false, true]) {
    const lib = openLibrary(TMP);
    try {
      await readSeveral(lib, "a", "Jane Doe", 2);
      await readSeveral(lib, "b", "J. Doe", 1);
      const jane = idOf(lib, "Jane Doe");
      const abbreviated = idOf(lib, "J. Doe");

      const merged = reversed
        ? mergeEntities(lib, abbreviated, jane)
        : mergeEntities(lib, jane, abbreviated);

      expect(merged.survivor.displayName).toBe("Jane Doe");
      expect(merged.survivor.id).toBe(jane);
      expect(merged.absorbed.displayName).toBe("J. Doe");
    } finally {
      closeLibrary(lib);
      await rm(TMP, { recursive: true, force: true });
    }
  }
});

test("the most frequent variant wins over a group that outnumbers it between them", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Xavier Ng", 5);
    await readSeveral(lib, "b", "X. Ng", 4);
    await readSeveral(lib, "c", "Ng, Xavier", 8);
    mergeEntities(lib, idOf(lib, "Xavier Ng"), idOf(lib, "X. Ng"));

    // Nine Documents between them, but no one spelling of them beats eight.
    mergeEntities(lib, idOf(lib, "Xavier Ng"), idOf(lib, "Ng, Xavier"));

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Ng, Xavier", 17],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("the owner's chosen name overrides the most frequent variant", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);

    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane Elizabeth Doe",
    });

    expect(named(lib, "Jane Elizabeth Doe")?.documents).toBe(3);
  } finally {
    closeLibrary(lib);
  }
});

test("a Document that names both spellings is still one Document", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), {
      sender: { organization: "", person: "Jane Doe" },
      receiver: { organization: "", person: "J. Doe" },
    });

    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));

    const jane = named(lib, "Jane Doe");
    expect(jane?.documents).toBe(1);
    // Nothing was rewritten, so both parts the name played are still on record.
    expect(jane?.roles).toEqual(["sender", "receiver"]);
  } finally {
    closeLibrary(lib);
  }
});

test("the Organizations a merged Person appeared for are those of both spellings", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), from("Jane Doe", "Stadt Porto"));
    await enrich(lib, "bbb".padEnd(64, "0"), from("J. Doe", "Region Osaka"));

    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));

    expect(
      named(lib, "Jane Doe")?.affiliations.map((a) => a.displayName),
    ).toEqual(["Region Osaka", "Stadt Porto"]);
  } finally {
    closeLibrary(lib);
  }
});

test("merged Organizations are one affiliation, not two", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), from("Jane Doe", "Stadt Porto"));
    await enrich(
      lib,
      "bbb".padEnd(64, "0"),
      from("Jane Doe", "stadt porto ag"),
    );

    mergeEntities(lib, idOf(lib, "Stadt Porto"), idOf(lib, "stadt porto ag"));

    expect(named(lib, "Jane Doe")?.affiliations).toEqual([
      { id: idOf(lib, "Stadt Porto"), displayName: "Stadt Porto" },
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("an affiliation to a Merged Organization is the surviving Organization", async () => {
  const lib = openLibrary(TMP);
  try {
    // Jane only ever acted for the branch spelling, which loses the Merge.
    await enrich(lib, "aaa".padEnd(64, "0"), from("Jane Doe", "Einwohneramt"));
    await readSeveralFor(lib, "b", "A. Keller", "Stadt Porto", 2);

    mergeEntities(lib, idOf(lib, "Stadt Porto"), idOf(lib, "Einwohneramt"));

    // The id is what puts her under an Organization when browsing, and only a
    // listed Organization can hold her — so it has to be the surviving one.
    expect(named(lib, "Jane Doe")?.affiliations).toEqual([
      { id: idOf(lib, "Stadt Porto"), displayName: "Stadt Porto" },
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("the listing says which names were Merged into an entity", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    const absorbed = idOf(lib, "J. Doe");

    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed);

    expect(named(lib, "Jane Doe")?.mergedNames).toEqual([
      { id: absorbed, displayName: "J. Doe" },
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("Merging a Person with an Organization is refused", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), from("Okafor", "Okafor"));
    const person = listEntities(lib).find((e) => e.kind === "person");
    const organization = listEntities(lib).find(
      (e) => e.kind === "organization",
    );

    expect(() =>
      mergeEntities(lib, person?.id ?? 0, organization?.id ?? 0),
    ).toThrow(/person.*organization|organization.*person/i);
    expect(listEntities(lib).length).toBe(2);
  } finally {
    closeLibrary(lib);
  }
});

test("every refusal says it is one, so a Library that cannot answer is not mistaken for one", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    await enrich(lib, "ccc".padEnd(64, "0"), from("Okafor", "Okafor"));
    const jane = idOf(lib, "Jane Doe");
    const organization = listEntities(lib).find(
      (e) => e.kind === "organization",
    );

    // Each of these is a statement about what was asked, which is what lets a
    // caller hand it to the owner as the answer. Anything else thrown from here
    // is the Library failing, and must not read like something they did.
    expect(() => mergeEntities(lib, jane, organization?.id ?? 0)).toThrow(
      MergeRefused,
    );
    expect(() => mergeEntities(lib, jane, jane)).toThrow(MergeRefused);
    expect(() => mergeEntities(lib, jane, 9999)).toThrow(MergeRefused);
    expect(() =>
      mergeEntities(lib, jane, idOf(lib, "J. Doe"), { displayName: "Okafor" }),
    ).toThrow(MergeRefused);
    expect(() => unmergeEntity(lib, jane)).toThrow(MergeRefused);
  } finally {
    closeLibrary(lib);
  }
});

test("Merging an entity with itself, or with one it already answers to, is refused", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    const jane = idOf(lib, "Jane Doe");
    const abbreviated = idOf(lib, "J. Doe");

    expect(() => mergeEntities(lib, jane, jane)).toThrow(/already/i);

    mergeEntities(lib, jane, abbreviated);
    expect(() => mergeEntities(lib, jane, abbreviated)).toThrow(/already/i);
  } finally {
    closeLibrary(lib);
  }
});

test("an unknown entity cannot be Merged", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);

    expect(() => mergeEntities(lib, idOf(lib, "Jane Doe"), 9999)).toThrow(
      /no person or organization/i,
    );
  } finally {
    closeLibrary(lib);
  }
});

test("a Merged pair is not still pointed out as a suspected duplicate", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jordan Okafor", 2);
    await readSeveral(lib, "b", "Okafor, Jordan", 1);
    expect(suggestDuplicates(listEntities(lib)).length).toBe(1);

    mergeEntities(lib, idOf(lib, "Jordan Okafor"), idOf(lib, "Okafor, Jordan"));

    // The question has been answered, so it is not asked again.
    expect(suggestDuplicates(listEntities(lib))).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

// ---- what a Merge means for a later reading -----------------------------

test("a newly Enriched Document carrying a merged variant resolves to the surviving entity", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));

    await enrich(lib, "ccc".padEnd(64, "0"), from("J. DOE"));

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 3],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("an unseen spelling still starts an entity of its own after a Merge", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));

    await enrich(lib, "ccc".padEnd(64, "0"), from("Jana Okafor"));

    expect(listEntities(lib).map((e) => e.displayName)).toEqual([
      "Jane Doe",
      "Jana Okafor",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Document using the owner's chosen name resolves to the entity they named", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
      displayName: "Jane Elizabeth Doe",
    });

    await enrich(lib, "ccc".padEnd(64, "0"), from("Jane Elizabeth Doe"));

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Elizabeth Doe", 3],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("a chosen name that is already another entity's is refused", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    await readSeveral(lib, "c", "Jana Okafor", 1);

    expect(() =>
      mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"), {
        displayName: "Jana Okafor",
      }),
    ).toThrow(/Jana Okafor/);
    expect(listEntities(lib).length).toBe(3); // nothing was merged
  } finally {
    closeLibrary(lib);
  }
});

test("the work of untangling a name survives Deleting the Documents it was learned from", async () => {
  await mkdir(FIXDIR, { recursive: true });
  const fixture = join(FIXDIR, "letter.pdf");
  await Bun.write(fixture, "%PDF-1.4\n% a letter from J. Doe\n");

  let lib = openLibrary(TMP);
  const { hash } = await importFile(lib, fixture);
  try {
    const record = getDocument(lib, hash);
    if (!record) throw new Error("expected the Document to be catalogued");
    await enrichDocument(lib, record, providerNaming(from("J. Doe")));
    await readSeveral(lib, "a", "Jane Doe", 2);
    mergeEntities(lib, idOf(lib, "Jane Doe"), idOf(lib, "J. Doe"));
  } finally {
    closeLibrary(lib);
  }

  lib = openLibrary(TMP);
  await deleteFile(lib, hash);

  // The same file arrives again: a fresh Document with no Enrichment, read anew.
  const reimported = await importFile(lib, fixture);
  try {
    const record = getDocument(lib, reimported.hash);
    if (!record) throw new Error("expected the Document to be catalogued");
    await enrichDocument(lib, record, providerNaming(from("J. Doe")));

    // Not merged a second time: the naming was settled once.
    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 3],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

// ---- Unmerging ----------------------------------------------------------

test("Unmerging restores the two entities as they were", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    const before = listEntities(lib);

    const absorbed = idOf(lib, "J. Doe");
    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed);
    unmergeEntity(lib, absorbed);

    expect(listEntities(lib)).toEqual(before);
  } finally {
    closeLibrary(lib);
  }
});

test("Unmerging puts back the display name the merge replaced", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    const absorbed = idOf(lib, "J. Doe");
    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed, {
      displayName: "Jane Elizabeth Doe",
    });

    unmergeEntity(lib, absorbed);

    expect(listEntities(lib).map((e) => e.displayName)).toEqual([
      "Jane Doe",
      "J. Doe",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("Unmerging gives back the Documents read while the names were one", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    const absorbed = idOf(lib, "J. Doe");
    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed);
    // Read while merged, under the absorbed spelling.
    await enrich(lib, "ccc".padEnd(64, "0"), from("J. Doe"));

    unmergeEntity(lib, absorbed);

    // The Document said "J. Doe", so it goes back with that spelling.
    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["J. Doe", 2],
      ["Jane Doe", 1],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("Unmerging one Merge leaves the others standing", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 3);
    await readSeveral(lib, "b", "J. Doe", 2);
    await readSeveral(lib, "c", "Doe, Jane", 1);
    const jane = idOf(lib, "Jane Doe");
    const abbreviated = idOf(lib, "J. Doe");
    const inverted = idOf(lib, "Doe, Jane");
    mergeEntities(lib, jane, abbreviated);
    mergeEntities(lib, jane, inverted);

    unmergeEntity(lib, inverted);

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 5],
      ["Doe, Jane", 1],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("Unmerging a Merge made through another entity returns its own merges with it", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "J. Doe", 2);
    await readSeveral(lib, "b", "Doe, Jane", 1);
    const abbreviated = idOf(lib, "J. Doe");
    mergeEntities(lib, abbreviated, idOf(lib, "Doe, Jane"));
    // A third spelling arrives with more Documents, so it takes over the name.
    await readSeveral(lib, "c", "Jane Doe", 4);
    mergeEntities(lib, idOf(lib, "Jane Doe"), abbreviated);
    expect(named(lib, "Jane Doe")?.documents).toBe(7);

    unmergeEntity(lib, abbreviated);

    // "Doe, Jane" was merged into "J. Doe", and stays with it.
    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 4],
      ["J. Doe", 3],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("taking back an older Merge leaves a later name choice standing", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 3);
    await readSeveral(lib, "b", "J. Doe", 2);
    await readSeveral(lib, "c", "Doe, Jane", 1);
    const jane = idOf(lib, "Jane Doe");
    const abbreviated = idOf(lib, "J. Doe");
    mergeEntities(lib, jane, abbreviated, { displayName: "Jane E. Doe" });
    mergeEntities(lib, jane, idOf(lib, "Doe, Jane"), {
      displayName: "Jane Elizabeth Doe",
    });

    unmergeEntity(lib, abbreviated);

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Elizabeth Doe", 4],
      ["J. Doe", 2],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("Merges taken back out of order still give the oldest name back", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 3);
    await readSeveral(lib, "b", "J. Doe", 2);
    await readSeveral(lib, "c", "Doe, Jane", 1);
    const jane = idOf(lib, "Jane Doe");
    const abbreviated = idOf(lib, "J. Doe");
    const inverted = idOf(lib, "Doe, Jane");
    mergeEntities(lib, jane, abbreviated, { displayName: "Jane E. Doe" });
    mergeEntities(lib, jane, inverted, { displayName: "Jane Elizabeth Doe" });

    // Oldest first: its name choice is not the one on show, so the Merge that
    // replaced it takes on putting the original back.
    unmergeEntity(lib, abbreviated);
    unmergeEntity(lib, inverted);

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 3],
      ["J. Doe", 2],
      ["Doe, Jane", 1],
    ]);
    // And both spellings the Merges invented are gone with them.
    expect(findEntities(lib, "Jane E. Doe")).toEqual([]);
    expect(findEntities(lib, "Jane Elizabeth Doe")).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("an entity that answers only to itself cannot be unmerged", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);

    expect(() => unmergeEntity(lib, idOf(lib, "Jane Doe"))).toThrow(
      /not merged/i,
    );
    expect(() => unmergeEntity(lib, 9999)).toThrow(
      /no person or organization/i,
    );
  } finally {
    closeLibrary(lib);
  }
});

test("a Merge outlives the Documents it was made over", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 1);
    await readSeveral(lib, "b", "J. Doe", 1);
    const absorbed = idOf(lib, "J. Doe");
    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed);

    deleteDocument(lib, "a0".padEnd(64, "0"));
    deleteDocument(lib, "b0".padEnd(64, "0"));
    expect(listEntities(lib)).toEqual([]); // nothing left to browse

    await enrich(lib, "ccc".padEnd(64, "0"), from("J. Doe"));

    expect(listEntities(lib).map((e) => [e.displayName, e.documents])).toEqual([
      ["Jane Doe", 1],
    ]);
    // And it is still the merge the owner made, so it can still be taken back.
    unmergeEntity(lib, absorbed);
    expect(listEntities(lib).map((e) => e.displayName)).toEqual(["J. Doe"]);
  } finally {
    closeLibrary(lib);
  }
});

// ---- naming an entity on the command line -------------------------------

test("an entity is found by its id, by a spelling it was seen under, or not at all", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), from("Jane Doe", "Stadt Porto"));
    const jane = idOf(lib, "Jane Doe");

    expect(findEntities(lib, String(jane)).map((e) => e.id)).toEqual([jane]);
    expect(findEntities(lib, "jane  doe").map((e) => e.id)).toEqual([jane]);
    expect(findEntities(lib, "Stadt Porto").map((e) => e.kind)).toEqual([
      "organization",
    ]);
    expect(findEntities(lib, "Jana Okafor")).toEqual([]);
    expect(findEntities(lib, "4711")).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("a spelling two kinds answer to finds both, for the owner to choose between", async () => {
  const lib = openLibrary(TMP);
  try {
    await enrich(lib, "aaa".padEnd(64, "0"), from("Okafor", "Okafor"));

    expect(
      findEntities(lib, "Okafor")
        .map((e) => e.kind)
        .sort(),
    ).toEqual(["organization", "person"]);
  } finally {
    closeLibrary(lib);
  }
});

test("a Merged spelling finds the entity it was learned for, so it can be unmerged", async () => {
  const lib = openLibrary(TMP);
  try {
    await readSeveral(lib, "a", "Jane Doe", 2);
    await readSeveral(lib, "b", "J. Doe", 1);
    const absorbed = idOf(lib, "J. Doe");
    mergeEntities(lib, idOf(lib, "Jane Doe"), absorbed);

    const found = findEntities(lib, "J. Doe");
    expect(found.map((e) => e.id)).toEqual([absorbed]);
    expect(found[0]?.mergedInto).toBe(idOf(lib, "Jane Doe"));
  } finally {
    closeLibrary(lib);
  }
});
