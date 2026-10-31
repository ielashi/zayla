import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "yaml";
import {
  type CatalogFields,
  closeLibrary,
  getDocument,
  insertDocument,
  listDocuments,
  openLibrary,
} from "./db.ts";
import type { EnrichedMetadata, EnrichmentProvider } from "./enrich.ts";
import { enrichDocument } from "./enrich.ts";
import { listEntities } from "./entities.ts";
import { importFile } from "./ingest.ts";
import { objectPath } from "./library.ts";
import { searchLibrary } from "./search.ts";

/**
 * What the Library knows about each Document is held in a readable file beside
 * its Transcription, and read back whenever the Library is opened.
 */

const TMP = `/tmp/dm-documents-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const HASH = "a".repeat(64);
const DOCUMENT_FILE = `${TMP}/about/${HASH}/document.yaml`;

const catalog = (hash = HASH): CatalogFields => ({
  hash,
  ext: "pdf",
  mime: "application/pdf",
  filename: "lease.pdf",
  bytes: 1234,
  status: "imported",
  addedAt: "2026-01-02T03:04:05.000Z",
});

const READING: EnrichedMetadata = {
  texts: {
    EN: {
      title: "Lease for the third-floor flat",
      summary:
        "A three-year lease for the flat on the third floor, with the rent paid monthly in advance.",
    },
    DE: {
      title: "Mietvertrag für die Wohnung im dritten Stock",
      summary: "Ein Mietvertrag über drei Jahre.",
    },
  },
  people: ["Jordan Okafor"],
  sender: { organization: "Nordhaus AG", person: "M. Schmidt" },
  receiver: { organization: "", person: "Jordan Okafor" },
  deadlines: [{ label: "Pay deposit", date: "2026-03-01" }],
  date: "2026-02-15",
  languages: ["DE"],
  keywords: ["mietvertrag", "kaution"],
};

const provider = (
  transcription: string | null,
  finishReason: string | null = "stop",
): EnrichmentProvider => ({
  baseUrl: "http://mock.test/v1",
  model: "mock",
  async enrich() {
    return { meta: READING, transcription, finishReason, costUsd: null };
  },
});

test("a Document, its Enrichment and both kinds of provenance survive closing and reopening the Library", async () => {
  const first = openLibrary(TMP);
  insertDocument(first, catalog());
  const doc = getDocument(first, HASH);
  if (!doc) throw new Error("expected the Document to be filed");
  await enrichDocument(first, doc, provider("Mietvertrag\n\nNordhaus AG"), [
    "EN",
    "DE",
  ]);
  const before = getDocument(first, HASH);
  closeLibrary(first);

  const lib = openLibrary(TMP);
  try {
    const after = getDocument(lib, HASH);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      filename: "lease.pdf",
      status: "enriched",
      addedAt: "2026-01-02T03:04:05.000Z",
      texts: READING.texts,
      sender: READING.sender,
      deadlines: READING.deadlines,
      docDate: "2026-02-15",
      enrichBaseUrl: "http://mock.test/v1",
      enrichModel: "mock",
      transcriptionProvenance: {
        truncated: false,
        finishReason: "stop",
        baseUrl: "http://mock.test/v1",
        model: "mock",
        chars: "Mietvertrag\n\nNordhaus AG".length,
      },
    });
    expect(Object.keys(after?.texts ?? {})).toEqual(["EN", "DE"]);
    expect(listDocuments(lib).map((d) => d.hash)).toEqual([HASH]);
  } finally {
    closeLibrary(lib);
  }
});

test("document.yaml parses as YAML and carries the fields a person would look for, the summary as unquoted prose", async () => {
  const lib = openLibrary(TMP);
  try {
    insertDocument(lib, catalog());
    const doc = getDocument(lib, HASH);
    if (!doc) throw new Error("expected the Document to be filed");
    await enrichDocument(lib, doc, provider("Mietvertrag", "length"), [
      "EN",
      "DE",
    ]);
  } finally {
    closeLibrary(lib);
  }

  const text = await Bun.file(DOCUMENT_FILE).text();
  const file = parse(text);
  expect(file).toMatchObject({
    filename: "lease.pdf",
    mime: "application/pdf",
    bytes: 1234,
    status: "enriched",
    added_at: "2026-01-02T03:04:05.000Z",
    date: "2026-02-15",
    sender: { organization: "Nordhaus AG", person: "M. Schmidt" },
    keywords: ["mietvertrag", "kaution"],
    texts: {
      EN: READING.texts.EN,
      DE: READING.texts.DE,
    },
    enrichment: { base_url: "http://mock.test/v1", model: "mock" },
    transcription: {
      base_url: "http://mock.test/v1",
      model: "mock",
      truncated: true,
    },
  });
  expect(file.enrichment.enriched_at).toEqual(expect.any(String));
  // Written as prose, whole on one line, neither quoted nor escaped.
  expect(text).toContain(`    summary: ${READING.texts.EN?.summary}\n`);
  // The Transcription's own sidecar is gone: its provenance lives here.
  expect(
    await Bun.file(`${TMP}/about/${HASH}/transcription.meta.json`).exists(),
  ).toBe(false);
});

test("an Original with no document.yaml is not in the Library, and Importing it again completes it", async () => {
  const source = `${TMP}-source/lease.pdf`;
  await Bun.write(source, "%PDF-1.4\n% lease\n");
  try {
    const first = openLibrary(TMP);
    const { hash } = await importFile(first, source);
    closeLibrary(first);
    // As an Import interrupted before its document.yaml was written leaves it.
    await rm(`${TMP}/about/${hash}/document.yaml`);

    const lib = openLibrary(TMP);
    try {
      expect(getDocument(lib, hash)).toBeNull();
      expect(listDocuments(lib)).toEqual([]);
      expect(await Bun.file(objectPath(TMP, hash, "pdf")).exists()).toBe(true);

      const again = await importFile(lib, source);

      expect(again).toMatchObject({ hash, deduped: false });
      expect(getDocument(lib, hash)?.filename).toBe("lease.pdf");
    } finally {
      closeLibrary(lib);
    }
    const reopened = openLibrary(TMP);
    try {
      expect(listDocuments(reopened).map((d) => d.hash)).toEqual([hash]);
    } finally {
      closeLibrary(reopened);
    }
  } finally {
    await rm(`${TMP}-source`, { recursive: true, force: true });
  }
});

test("a Document whose Delete was interrupted after its document.yaml was removed is not in the Library", async () => {
  const first = openLibrary(TMP);
  insertDocument(first, catalog());
  const doc = getDocument(first, HASH);
  if (!doc) throw new Error("expected the Document to be filed");
  await enrichDocument(first, doc, provider("Mietvertrag Nordhaus"), ["EN"]);
  closeLibrary(first);
  // As a Delete interrupted after its first step leaves it: the Transcription,
  // and everything but document.yaml, still there.
  await rm(DOCUMENT_FILE);

  const lib = openLibrary(TMP);
  try {
    expect(getDocument(lib, HASH)).toBeNull();
    expect(listDocuments(lib)).toEqual([]);
    expect(searchLibrary(lib, "nordhaus")).toEqual([]);
    expect(listEntities(lib)).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("a field missing from an older document.yaml reads as its default", async () => {
  await mkdir(dirname(DOCUMENT_FILE), { recursive: true });
  await Bun.write(
    DOCUMENT_FILE,
    "filename: lease.pdf\next: pdf\nmime: application/pdf\nbytes: 3\nstatus: imported\nadded_at: 2026-01-02T03:04:05.000Z\n",
  );

  const lib = openLibrary(TMP);
  try {
    expect(getDocument(lib, HASH)).toMatchObject({
      filename: "lease.pdf",
      texts: {},
      keywords: null,
      enrichBaseUrl: null,
      transcriptionProvenance: null,
    });
  } finally {
    closeLibrary(lib);
  }
});

test("an Enrichment that named a provider rather than an address keeps it, with no address invented for it", async () => {
  await mkdir(dirname(DOCUMENT_FILE), { recursive: true });
  await Bun.write(
    DOCUMENT_FILE,
    "filename: lease.pdf\next: pdf\nmime: application/pdf\nbytes: 3\nstatus: enriched\nadded_at: 2026-01-02T03:04:05.000Z\nenrichment:\n  text_source: vision\n  model: some-model\n  enriched_at: 2025-06-01T00:00:00.000Z\n  provider: mlx\n",
  );

  const lib = openLibrary(TMP);
  try {
    const doc = getDocument(lib, HASH);
    expect(doc?.enrichProvider).toBe("mlx");
    expect(doc?.enrichBaseUrl).toBeNull();
    if (!doc) return;
    // Read again, it keeps the name beside its new address.
    await enrichDocument(lib, doc, provider(null), ["EN"]);
    expect(getDocument(lib, HASH)).toMatchObject({
      enrichProvider: "mlx",
      enrichBaseUrl: "http://mock.test/v1",
    });
  } finally {
    closeLibrary(lib);
  }
});
