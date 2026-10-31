import { afterEach, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createUser } from "./auth.ts";
import {
  type CatalogFields,
  closeLibrary,
  type DocumentRecord,
  getDocument,
  insertDocument,
  type Library,
  openLibrary,
} from "./db.ts";
import {
  clearProvider,
  type EnrichedMetadata,
  type EnrichmentProvider,
  enrichDocument,
  getProvider,
  keyFor,
  NoProvider,
  type ProviderConfig,
  parseMetadata,
  savedProvider,
  saveProvider,
  splitResponse,
} from "./enrich.ts";
import { listEntities } from "./entities.ts";
import { deleteFile } from "./ingest.ts";
import { objectPath } from "./library.ts";
import { readTranscription } from "./transcription.ts";

const TMP = `/tmp/dm-enrich-test-${process.pid}`;

beforeEach(() => {
  process.env.LIBRARY_DIR = TMP;
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test("parseMetadata: normalizes a well-formed response", () => {
  const meta = parseMetadata(
    JSON.stringify({
      title: "Residence visa",
      people: ["Jordan Okafor"],
      sender: { organization: "Ausländerbehörde Berlin", person: "M. Schmidt" },
      receiver: { organization: "", person: "Jordan Okafor" },
      deadlines: [{ label: "Register residence", date: "2026-06-30" }],
      date: "2026-05-20",
      languages: ["en", "fr"],
      keywords: ["aufenthaltstitel", "type d"],
      summary: "A national residence visa.",
      ref: [{ key: "Visa no.", value: "D-2048817" }],
    }),
  );
  expect(meta.keywords).toEqual(["aufenthaltstitel", "type d"]);
  expect(meta.languages).toEqual(["EN", "FR"]); // uppercased
  expect(meta.date).toBe("2026-05-20");
  expect(meta.sender).toEqual({
    organization: "Ausländerbehörde Berlin",
    person: "M. Schmidt",
  });
  expect(meta.receiver).toEqual({ organization: "", person: "Jordan Okafor" });
  expect(meta.deadlines).toEqual([
    { label: "Register residence", date: "2026-06-30" },
  ]);
  expect(meta.ref).toEqual([{ key: "Visa no.", value: "D-2048817" }]);
});

test("parseMetadata: missing fields default sensibly", () => {
  const meta = parseMetadata(JSON.stringify({ title: "X" }));
  expect(meta.people).toEqual([]);
  expect(meta.keywords).toEqual([]);
  expect(meta.ref).toEqual([]);
  expect(meta.sender).toEqual({ organization: "", person: "" });
  expect(meta.receiver).toEqual({ organization: "", person: "" });
  expect(meta.deadlines).toEqual([]);
  expect(meta.date).toBeNull();
  expect(meta.texts).toEqual({});
});

test("parseMetadata: tolerates markdown fences and surrounding prose", () => {
  const wrapped =
    'Sure:\n```json\n{"title":{"EN":"T"},"summary":{"EN":"S"}}\n```\nDone!';
  const meta = parseMetadata(wrapped);
  expect(meta.texts).toEqual({ EN: { title: "T", summary: "S" } });
});

/** The Provider a one-run choice gives, where no Provider has been saved. */
const providerFor = (cfg: ProviderConfig): EnrichmentProvider =>
  getProvider(null, cfg);

/** A user of a fresh Library, to save a Provider for. */
const userOf = (lib: Library, username = "owner") =>
  createUser(lib, username, username).id;

test("getProvider: reads the Provider the user has chosen", () => {
  const lib = openLibrary(TMP);
  try {
    const owner = userOf(lib);
    saveProvider(lib, owner, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });

    const p = getProvider(savedProvider(lib, owner));

    expect(p.baseUrl).toBe("http://127.0.0.1:8001/v1");
    expect(p.model).toBe("gemma");
  } finally {
    closeLibrary(lib);
  }
});

test("getProvider: a one-run endpoint or model wins over the saved one, and saves nothing", () => {
  const lib = openLibrary(TMP);
  try {
    const owner = userOf(lib);
    saveProvider(lib, owner, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });

    const p = getProvider(savedProvider(lib, owner), {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
    });

    expect(p.baseUrl).toBe("https://example.test/api/v1");
    expect(p.model).toBe("qwen/x");
    expect(savedProvider(lib, owner)).toMatchObject({
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
    });
  } finally {
    closeLibrary(lib);
  }
});

test("getProvider: no saved Provider says so, whatever the environment holds", () => {
  const keys = ["ENRICH_BASE_URL", "ENRICH_MODEL", "ENRICH_API_KEY"] as const;
  const before = keys.map((k) => process.env[k]);
  process.env.ENRICH_BASE_URL = "http://127.0.0.1:8001/v1";
  process.env.ENRICH_MODEL = "gemma";
  process.env.ENRICH_API_KEY = "sk-test";
  try {
    expect(() => getProvider(null)).toThrow(NoProvider);
  } finally {
    keys.forEach((k, i) => {
      const v = before[i];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  }
});

test("getProvider: one run can name an endpoint and a model where none is saved", () => {
  const p = providerFor({
    baseUrl: "http://127.0.0.1:8001/v1",
    model: "gemma",
  });

  expect(p.baseUrl).toBe("http://127.0.0.1:8001/v1");
  expect(p.model).toBe("gemma");
  expect(() => providerFor({ baseUrl: "http://127.0.0.1:8001/v1" })).toThrow(
    NoProvider,
  );
});

test("clearProvider: the user goes back to having none, key and all", () => {
  const lib = openLibrary(TMP);
  try {
    const owner = userOf(lib);
    saveProvider(lib, owner, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
      apiKey: "sk-test",
    });

    clearProvider(lib, owner);

    expect(savedProvider(lib, owner)).toBeNull();
    expect(() => getProvider(savedProvider(lib, owner))).toThrow(NoProvider);
  } finally {
    closeLibrary(lib);
  }
});

test("each user's Provider is their own: saving or clearing one leaves the other's", () => {
  const lib = openLibrary(TMP);
  try {
    const ada = userOf(lib, "ada");
    const ben = userOf(lib, "ben");
    saveProvider(lib, ada, {
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
      apiKey: "sk-ada",
    });
    saveProvider(lib, ben, {
      baseUrl: "https://example.test/api/v1",
      model: "qwen/x",
    });

    clearProvider(lib, ben);

    expect(savedProvider(lib, ada)).toMatchObject({
      baseUrl: "http://127.0.0.1:8001/v1",
      model: "gemma",
      apiKey: "sk-ada",
    });
    expect(savedProvider(lib, ben)).toBeNull();
    expect(keyFor(lib, ben, "http://127.0.0.1:8001/v1")).toBeNull();
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: hands the stored file to the provider and stores its metadata", async () => {
  const lib = openLibrary(TMP);
  try {
    const rec: CatalogFields = {
      hash: "a".repeat(64),
      ext: "jpg",
      mime: "image/jpeg",
      filename: "photo.jpg",
      bytes: 1234,
      status: "imported",
      addedAt: new Date().toISOString(),
    };
    insertDocument(lib, rec);

    let seen: unknown = null;
    const provider: EnrichmentProvider = {
      baseUrl: "http://mock.test/v1",
      model: "mock",
      async enrich(doc) {
        seen = doc;
        return {
          meta: {
            texts: { EN: { title: "Scan", summary: "" } },
            people: [],
            sender: { organization: "", person: "" },
            receiver: { organization: "", person: "" },
            deadlines: [],
            date: null,
            languages: [],
            keywords: [],
            ref: [],
          },
          transcription: null,
          finishReason: null,
          costUsd: 0.0012,
        };
      },
    };

    const doc = getDocument(lib, rec.hash);
    if (!doc) throw new Error("expected document to be catalogued");
    const out = await enrichDocument(lib, doc, provider);

    expect(out.status).toBe("enriched");
    expect(out.costUsd).toBe(0.0012);
    expect(seen).toEqual({
      path: expect.stringContaining(rec.hash),
      mime: "image/jpeg",
      filename: "photo.jpg",
      readingLanguages: ["EN"],
    });
    const stored = getDocument(lib, rec.hash);
    if (!stored) throw new Error("expected document to be catalogued");
    expect(stored.status).toBe("enriched");
    expect(stored.texts).toEqual({ EN: { title: "Scan", summary: "" } });
    expect(stored.textSource).toBe("vision");
    expect(stored.enrichBaseUrl).toBe("http://mock.test/v1");
    expect(stored.enrichProvider).toBeNull();
  } finally {
    closeLibrary(lib);
  }
});

test("splitResponse: separates the metadata JSON from the transcription after it", () => {
  const { json, transcription } = splitResponse(
    '{"title":"Invoice"}\n---TRANSCRIPTION---\nRechnung Nr. 4711\n\nBetrag: 129,00 EUR',
  );

  expect(parseMetadata(json, ["EN"]).texts.EN?.title).toBe("Invoice");
  expect(transcription).toBe("Rechnung Nr. 4711\n\nBetrag: 129,00 EUR");
});

test("splitResponse: a response with no sentinel is metadata and no transcription", () => {
  const { json, transcription } = splitResponse('{"title":"Invoice"}');

  expect(parseMetadata(json, ["EN"]).texts.EN?.title).toBe("Invoice");
  expect(transcription).toBeNull();
});

test("splitResponse: a sentinel with nothing after it yields no transcription", () => {
  const { transcription } = splitResponse(
    '{"title":"Invoice"}\n---TRANSCRIPTION---\n   \n',
  );

  expect(transcription).toBeNull();
});

test("splitResponse: splits on the first sentinel, leaving a later one in the text", () => {
  const { transcription } = splitResponse(
    '{"title":"Invoice"}\n---TRANSCRIPTION---\nsee below\n---TRANSCRIPTION---\nmore',
  );

  expect(transcription).toBe("see below\n---TRANSCRIPTION---\nmore");
});

test("splitResponse: a transcription cut off mid-word still leaves parseable metadata", () => {
  const { json, transcription } = splitResponse(
    '{"title":"Invoice","summary":"An invoice."}\n---TRANSCRIPTION---\nRechnung Nr. 4711\nBetrag: 129,0',
  );

  expect(parseMetadata(json, ["EN"]).texts.EN?.summary).toBe("An invoice.");
  expect(transcription).toBe("Rechnung Nr. 4711\nBetrag: 129,0");
});

/** Metadata is irrelevant to the transcription tests below; only the text is asserted. */
const EMPTY_META: EnrichedMetadata = {
  texts: {},
  people: [],
  sender: { organization: "", person: "" },
  receiver: { organization: "", person: "" },
  deadlines: [],
  date: null,
  languages: [],
  keywords: [],
  ref: [],
};

/** A provider that reads back exactly this, so a test can assert on what got stored. */
const providerReading = (
  transcription: string | null,
  finishReason: string | null = "stop",
): EnrichmentProvider => ({
  baseUrl: "http://mock.test/v1",
  model: "mock",
  async enrich() {
    return { meta: EMPTY_META, transcription, finishReason, costUsd: null };
  },
});

/** Catalog a document so it can be enriched, and hand back its record. */
function catalogued(lib: Library, hash: string): DocumentRecord {
  const rec: CatalogFields = {
    hash,
    ext: "pdf",
    mime: "application/pdf",
    filename: "invoice.pdf",
    bytes: 9,
    status: "imported",
    addedAt: new Date().toISOString(),
  };
  insertDocument(lib, rec);
  const doc = getDocument(lib, hash);
  if (!doc) throw new Error("expected document to be catalogued");
  return doc;
}

test("enrichDocument: stores the transcription the provider read back", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "c".repeat(64));

    await enrichDocument(lib, doc, providerReading("Rechnung Nr. 4711"));

    expect(await readTranscription(TMP, doc.hash)).toBe("Rechnung Nr. 4711");
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a provider that reads back nothing stores no transcription", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "d".repeat(64));

    await enrichDocument(lib, doc, providerReading(null));

    expect(await readTranscription(TMP, doc.hash)).toBeNull();
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a re-reading with no transcription fails and leaves the Document's reading whole", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "e".repeat(64));
    const first: EnrichmentProvider = {
      ...providerReading("Rechnung Nr. 4711"),
      model: "first",
    };
    await enrichDocument(lib, doc, first);

    await expect(
      enrichDocument(lib, doc, providerReading(null)),
    ).rejects.toThrow("no Transcription");

    expect(await readTranscription(TMP, doc.hash)).toBe("Rechnung Nr. 4711");
    expect(getDocument(lib, doc.hash)?.enrichModel).toBe("first");
  } finally {
    closeLibrary(lib);
  }
});

// ---- Appearances --------------------------------------------------------

/** A provider whose reading names exactly these parties. */
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

test("enrichDocument: a reading that arrives after the Document was Deleted is discarded", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "f".repeat(64));
    const reading = providerNaming({
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });
    const provider: EnrichmentProvider = {
      ...reading,
      async enrich(input) {
        const result = await reading.enrich(input);
        await deleteFile(lib, doc.hash); // Deleted while the Provider was reading
        return { ...result, transcription: "Rechnung Nr. 4711" };
      },
    };

    const out = await enrichDocument(lib, doc, provider);

    expect(out.status).toBe("deleted");
    expect(getDocument(lib, doc.hash)).toBeNull();
    expect(await readTranscription(TMP, doc.hash)).toBeNull();
    expect(listEntities(lib)).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a reading that arrives after the Document was Deleted learns no Name variants", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "f".repeat(64));
    const reading = providerNaming({
      sender: { organization: "STADT PORTO", person: "" },
    });
    await enrichDocument(lib, doc, {
      ...reading,
      async enrich(input) {
        const result = await reading.enrich(input);
        await deleteFile(lib, doc.hash);
        return result;
      },
    });

    // Had the discarded reading taught its spelling, this Document would be
    // filed under it.
    const next = catalogued(lib, "e".repeat(64));
    await enrichDocument(
      lib,
      next,
      providerNaming({ sender: { organization: "Stadt Porto", person: "" } }),
    );
    expect(listEntities(lib).map((e) => e.displayName)).toEqual([
      "Stadt Porto",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a reading whose document.yaml is gone writes nothing", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "f".repeat(64));
    await enrichDocument(lib, doc, {
      ...providerNaming({
        sender: { organization: "Stadt Porto", person: "" },
      }),
      async enrich() {
        // Deleted by a Delete that got no further than its first step.
        await rm(`${TMP}/about/${doc.hash}/document.yaml`);
        return {
          meta: EMPTY_META,
          transcription: "Rechnung Nr. 4711",
          finishReason: "stop",
          costUsd: null,
        };
      },
    });

    expect(await readTranscription(TMP, doc.hash)).toBeNull();
    expect(
      await Bun.file(`${TMP}/about/${doc.hash}/document.yaml`).exists(),
    ).toBe(false);
    expect(listEntities(lib)).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: the names a reading gives appear with the roles they played", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "1".repeat(64));

    await enrichDocument(
      lib,
      doc,
      providerNaming({
        sender: { organization: "Stadt Porto", person: "M. Schmidt" },
        receiver: { organization: "", person: "Jordan Okafor" },
        people: ["Jana Okafor"],
      }),
    );

    expect(
      listEntities(lib).map((e) => [e.kind, e.displayName, e.roles]),
    ).toEqual([
      ["person", "Jana Okafor", ["mentioned"]],
      ["person", "Jordan Okafor", ["receiver"]],
      ["person", "M. Schmidt", ["sender"]],
      ["organization", "Stadt Porto", ["sender"]],
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a Person's Appearance carries the Organization they acted for", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "2".repeat(64));

    await enrichDocument(
      lib,
      doc,
      providerNaming({
        sender: { organization: "Stadt Porto", person: "M. Schmidt" },
      }),
    );

    const schmidt = listEntities(lib).find(
      (e) => e.displayName === "M. Schmidt",
    );
    expect(schmidt?.affiliations.map((a) => a.displayName)).toEqual([
      "Stadt Porto",
    ]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: reading a Document again doesn't make its names appear twice", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "3".repeat(64));
    const reading = providerNaming({
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    });

    await enrichDocument(lib, doc, reading);
    await enrichDocument(lib, doc, reading);

    expect(listEntities(lib).map((e) => e.documents)).toEqual([1, 1]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a party crowding two signatories into one field yields both", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "4".repeat(64));

    await enrichDocument(
      lib,
      doc,
      providerNaming({
        sender: {
          organization: "Stadt Porto",
          person: "M. Schmidt / A. Keller",
        },
      }),
    );

    expect(
      listEntities(lib)
        .filter((e) => e.kind === "person")
        .map((e) => e.displayName),
    ).toEqual(["A. Keller", "M. Schmidt"]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a reading with no parties records no Appearances", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "5".repeat(64));

    await enrichDocument(lib, doc, providerNaming({}));

    expect(listEntities(lib)).toEqual([]);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a reading stopped by the output ceiling is recorded as truncated", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "f".repeat(64));

    await enrichDocument(
      lib,
      doc,
      providerReading("Rechnung Nr. 47", "length"),
    );

    const meta = getDocument(lib, doc.hash)?.transcriptionProvenance;
    expect(meta?.truncated).toBe(true);
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: a backend that reports no stop reason leaves truncation unknown, not false", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "0".repeat(64));

    await enrichDocument(lib, doc, providerReading("Rechnung Nr. 4711", null));

    const meta = getDocument(lib, doc.hash)?.transcriptionProvenance;
    expect(meta?.truncated).toBeNull();
  } finally {
    closeLibrary(lib);
  }
});

// ---- the wire -------------------------------------------------------------

type Captured = { headers: Headers; body: Record<string, unknown> };

/**
 * A stand-in chat completions server that records each request and answers
 * with this completion. Only the protocol is faked; the client under test is real.
 */
function fakeEndpoint(completion: unknown) {
  const seen: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({
        headers: req.headers,
        body: (await req.json()) as Record<string, unknown>,
      });
      return Response.json(completion);
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, seen, server };
}

const COMPLETION = {
  choices: [
    {
      message: {
        content: '{"title":"Invoice"}\n---TRANSCRIPTION---\nRechnung',
      },
      finish_reason: "stop",
    },
  ],
};

/** A small stored document of this type, ready to hand to a provider. */
async function storedFile(name: string, mime: string, bytes: string) {
  const path = `${TMP}/${name}`;
  await Bun.write(path, bytes);
  return { path, mime, filename: name, readingLanguages: ["EN"] };
}

const base64 = (s: string) => Buffer.from(s).toString("base64");

test("the request carries only standard parts: system instructions and an image as a data URL", async () => {
  const { baseUrl, seen, server } = fakeEndpoint(COMPLETION);
  try {
    const doc = await storedFile("scan.png", "image/png", "PNGDATA");

    await providerFor({ baseUrl, model: "gemma" }).enrich(doc);

    const body = seen[0]?.body as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
    expect(body.model).toBe("gemma");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.messages[1]?.content).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${base64("PNGDATA")}` },
    });
    expect(seen[0]?.headers.get("authorization")).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("a PDF goes as a standard file part, not as images", async () => {
  const { baseUrl, seen, server } = fakeEndpoint(COMPLETION);
  try {
    const doc = await storedFile("lease.pdf", "application/pdf", "%PDF-1.4");

    await providerFor({ baseUrl, model: "gemma" }).enrich(doc);

    const messages = seen[0]?.body.messages as { content: unknown }[];
    const user = messages[1];
    expect(user?.content).toContainEqual({
      type: "file",
      file: {
        filename: "lease.pdf",
        file_data: `data:application/pdf;base64,${base64("%PDF-1.4")}`,
      },
    });
  } finally {
    server.stop(true);
  }
});

test("a configured key is sent as a bearer token", async () => {
  const { baseUrl, seen, server } = fakeEndpoint(COMPLETION);
  try {
    const doc = await storedFile("scan.png", "image/png", "PNGDATA");

    await providerFor({ baseUrl, model: "gemma", apiKey: "sk-test" }).enrich(
      doc,
    );

    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-test");
  } finally {
    server.stop(true);
  }
});

test("a saved key goes to the Provider's address, and never to another one", async () => {
  const chosen = fakeEndpoint(COMPLETION);
  const other = fakeEndpoint(COMPLETION);
  const lib = openLibrary(TMP);
  try {
    const owner = userOf(lib);
    saveProvider(lib, owner, {
      baseUrl: chosen.baseUrl,
      model: "gemma",
      apiKey: "sk-test",
    });
    const saved = savedProvider(lib, owner);
    const doc = await storedFile("scan.png", "image/png", "PNGDATA");

    await getProvider(saved, { model: "qwen/x" }).enrich(doc);
    await getProvider(saved, { baseUrl: other.baseUrl }).enrich(doc);

    expect(chosen.seen[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(other.seen[0]?.headers.get("authorization")).toBeNull();
  } finally {
    closeLibrary(lib);
    chosen.server.stop(true);
    other.server.stop(true);
  }
});

test("the reading, its stop reason and a reported cost come back from the response", async () => {
  const { baseUrl, server } = fakeEndpoint({
    ...COMPLETION,
    usage: { cost: 0.0042 },
  });
  try {
    const doc = await storedFile("scan.png", "image/png", "PNGDATA");

    const out = await providerFor({ baseUrl, model: "gemma" }).enrich(doc);

    expect(out.meta.texts.EN?.title).toBe("Invoice");
    expect(out.transcription).toBe("Rechnung");
    expect(out.finishReason).toBe("stop");
    expect(out.costUsd).toBe(0.0042);
  } finally {
    server.stop(true);
  }
});

test("a server that reports no cost leaves it unknown", async () => {
  const { baseUrl, server } = fakeEndpoint(COMPLETION);
  try {
    const doc = await storedFile("scan.png", "image/png", "PNGDATA");

    const out = await providerFor({ baseUrl, model: "gemma" }).enrich(doc);

    expect(out.costUsd).toBeNull();
  } finally {
    server.stop(true);
  }
});

// ---- OpenRouter and Zero retention -----------------------------------------

/**
 * Run with OpenRouter's address pointing at a stand-in, so an OpenRouter
 * Provider can be chosen and read with, all without leaving this machine.
 */
async function atStandInOpenRouter<T>(
  baseUrl: string,
  run: () => Promise<T>,
): Promise<T> {
  const before = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = baseUrl;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = before;
  }
}

test("an OpenRouter Provider asks for Zero retention unless its user turned it off", async () => {
  const { baseUrl, seen, server } = fakeEndpoint(COMPLETION);
  const lib = openLibrary(TMP);
  try {
    await atStandInOpenRouter(baseUrl, async () => {
      const owner = userOf(lib);
      const doc = await storedFile("scan.png", "image/png", "PNGDATA");

      saveProvider(lib, owner, { kind: "openrouter", model: "qwen/x" });
      await getProvider(savedProvider(lib, owner)).enrich(doc);
      saveProvider(lib, owner, {
        kind: "openrouter",
        model: "qwen/x",
        zeroRetention: false,
      });
      await getProvider(savedProvider(lib, owner)).enrich(doc);
    });

    expect(seen[0]?.body.provider).toEqual({ zdr: true });
    expect(seen[1]?.body).not.toHaveProperty("provider");
  } finally {
    closeLibrary(lib);
    server.stop(true);
  }
});

test("a model no Zero retention host will read says so, and isn't sent anywhere else", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json(
        { error: { message: "No endpoints found matching your data policy" } },
        { status: 404 },
      );
    },
  });
  const lib = openLibrary(TMP);
  try {
    const failure = await atStandInOpenRouter(
      `http://127.0.0.1:${server.port}/api/v1`,
      async () => {
        const owner = userOf(lib);
        saveProvider(lib, owner, { kind: "openrouter", model: "kept/logs" });
        const doc = await storedFile("scan.png", "image/png", "PNGDATA");
        return getProvider(savedProvider(lib, owner))
          .enrich(doc)
          .catch((err: Error) => err);
      },
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "no host keeps Zero retention for kept/logs",
    );
    expect(requests).toBe(1);
  } finally {
    closeLibrary(lib);
    server.stop(true);
  }
});

// ---- Reading languages ----------------------------------------------------

/** A provider whose reading wrote exactly these titles and summaries. */
const providerWriting = (
  texts: EnrichedMetadata["texts"],
): EnrichmentProvider => ({
  baseUrl: "http://mock.test/v1",
  model: "mock",
  async enrich() {
    return {
      meta: { ...EMPTY_META, texts },
      transcription: null,
      finishReason: "stop",
      costUsd: null,
    };
  },
});

test("enrichDocument: the prompt asks, by name, for a title and summary in each Reading language", async () => {
  const { baseUrl, seen, server } = fakeEndpoint(COMPLETION);
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "1".repeat(64));
    await Bun.write(objectPath(TMP, doc.hash, doc.ext), "%PDF-1.4");

    await enrichDocument(lib, doc, providerFor({ baseUrl, model: "gemma" }), [
      "DE",
      "AR",
    ]);

    const messages = seen[0]?.body.messages as { content: string }[];
    const system = messages[0]?.content ?? "";
    expect(system).toContain("German");
    expect(system).toContain("Arabic");
    expect(system).not.toContain("English");
    // Keywords and the Transcription stay in the Document's own language.
    expect(system).toContain("original language");
    expect(system).toContain("Do not translate");
  } finally {
    closeLibrary(lib);
    server.stop(true);
  }
});

test("enrichDocument: the Reading languages are handed to the provider with the file", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "2".repeat(64));
    let seen: unknown = null;
    const provider: EnrichmentProvider = {
      ...providerWriting({}),
      async enrich(input) {
        seen = input;
        return providerWriting({}).enrich(input);
      },
    };

    await enrichDocument(lib, doc, provider, ["FR", "EN"]);

    expect(seen).toMatchObject({ readingLanguages: ["FR", "EN"] });
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: stores a title and summary for each language the reading wrote", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "3".repeat(64));

    await enrichDocument(
      lib,
      doc,
      providerWriting({
        DE: { title: "Mietvertrag", summary: "Ein Mietvertrag." },
        AR: { title: "عقد إيجار", summary: "عقد إيجار لشقة." },
      }),
      ["DE", "AR"],
    );

    expect(getDocument(lib, doc.hash)?.texts).toEqual({
      DE: { title: "Mietvertrag", summary: "Ein Mietvertrag." },
      AR: { title: "عقد إيجار", summary: "عقد إيجار لشقة." },
    });
  } finally {
    closeLibrary(lib);
  }
});

test("enrichDocument: reading a Document again replaces its titles and summaries, every language", async () => {
  const lib = openLibrary(TMP);
  try {
    const doc = catalogued(lib, "4".repeat(64));
    await enrichDocument(
      lib,
      doc,
      providerWriting({
        EN: { title: "Lease", summary: "A lease." },
        DE: { title: "Mietvertrag", summary: "Ein Mietvertrag." },
      }),
      ["EN", "DE"],
    );

    await enrichDocument(
      lib,
      doc,
      providerWriting({ FR: { title: "Bail", summary: "Un bail." } }),
      ["FR"],
    );

    expect(getDocument(lib, doc.hash)?.texts).toEqual({
      FR: { title: "Bail", summary: "Un bail." },
    });
  } finally {
    closeLibrary(lib);
  }
});

test("parseMetadata: titles and summaries come keyed by language, codes uppercased", () => {
  const meta = parseMetadata(
    JSON.stringify({
      title: { en: "Lease", DE: "Mietvertrag" },
      summary: { en: "A lease.", DE: "Ein Mietvertrag." },
    }),
    ["EN", "DE"],
  );

  expect(meta.texts).toEqual({
    EN: { title: "Lease", summary: "A lease." },
    DE: { title: "Mietvertrag", summary: "Ein Mietvertrag." },
  });
});

test("parseMetadata: a model that writes one plain title writes it in the first Reading language", () => {
  const meta = parseMetadata(
    JSON.stringify({ title: "Bail", summary: "Un bail." }),
    ["FR", "EN"],
  );

  expect(meta.texts).toEqual({ FR: { title: "Bail", summary: "Un bail." } });
});
