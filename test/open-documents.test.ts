import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectedAgent } from "./agent.ts";
import {
  newLibrary,
  type RunningZayla,
  startZayla,
  writeDocument,
  writeUser,
} from "./library.ts";

const PASSWORD = "correct horse";

let zayla: RunningZayla | null = null;
let agent: Client | null = null;
let library = "";

afterEach(async () => {
  await agent?.close();
  agent = null;
  await zayla?.stop();
  zayla = null;
  await rm(library, { recursive: true, force: true });
});

/**
 * A server over a Library `seed` writes into, with a user who reads in
 * `readingLanguages`, and an agent connected as them.
 */
async function agentOver(
  seed: (library: string) => Promise<void>,
  readingLanguages?: string[],
): Promise<Client> {
  library = await newLibrary();
  await writeUser(library, {
    username: "owner",
    password: PASSWORD,
    readingLanguages,
  });
  await seed(library);
  zayla = await startZayla(library, { zaylaUrl: "https://zayla.example.com" });
  agent = await connectedAgent(zayla, PASSWORD);
  return agent;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;

/** What a tool call answered, read from the JSON its text carries. */
function resultOf(called: Called) {
  const [first] = called.content as { type: string; text: string }[];
  if (first?.type !== "text") throw new Error("the tool answered no text");
  return JSON.parse(first.text);
}

/** The words a tool call answered with. */
function textOf(called: Called): string {
  return (called.content as { type: string; text?: string }[])
    .map((c) => c.text ?? "")
    .join("\n");
}

/** A German lease, read in English and Arabic as well as German. */
const LEASE = {
  filename: "mietvertrag.pdf",
  content: "%PDF-1.4 a German lease",
  texts: {
    DE: { title: "Mietvertrag für die Wohnung", summary: "Ein Mietvertrag." },
    EN: { title: "Apartment rental contract", summary: "A rental contract." },
    AR: { title: "عقد إيجار الشقة", summary: "عقد إيجار." },
  },
  languages: ["DE"],
  date: "2024-03-01",
  sender: { organization: "Hausverwaltung Müller", person: "Hans Müller" },
  receiver: { person: "Jane Doe" },
  people: ["Erika Muster"],
  keywords: ["Mietvertrag", "Kaution"],
  deadlines: [{ label: "Kaution zahlen", date: "2024-03-15" }],
  readBy: {
    model: "vision-model-1",
    baseUrl: "https://models.example.net/v1",
    at: "2024-03-02T10:00:00.000Z",
  },
  transcription: "Die Kaution beträgt drei Monatsmieten.",
  transcriptionTruncated: false,
};

test("get_document gives a Document's Enrichment, in its user's Reading languages, with where it came from", async () => {
  let hash = "";
  const agent = await agentOver(
    async (library) => {
      hash = await writeDocument(library, LEASE);
    },
    ["EN", "DE"],
  );

  const doc = resultOf(
    await agent.callTool({ name: "get_document", arguments: { hash } }),
  );
  expect(doc).toEqual({
    hash,
    filename: "mietvertrag.pdf",
    mediaType: "application/pdf",
    unread: false,
    title: "Mietvertrag für die Wohnung",
    summary: "Ein Mietvertrag.",
    texts: {
      EN: { title: "Apartment rental contract", summary: "A rental contract." },
      DE: { title: "Mietvertrag für die Wohnung", summary: "Ein Mietvertrag." },
    },
    languages: ["DE"],
    date: "2024-03-01",
    readDate: "2024-03-01",
    dateSetByOwner: false,
    sender: { organization: "Hausverwaltung Müller", person: "Hans Müller" },
    receiver: { organization: null, person: "Jane Doe" },
    deadlines: [{ label: "Kaution zahlen", date: "2024-03-15" }],
    keywords: ["Mietvertrag", "Kaution"],
    involved: expect.arrayContaining([
      {
        kind: "organization",
        name: "Hausverwaltung Müller",
        roles: ["sender"],
        actingFor: [],
      },
      {
        kind: "person",
        name: "Hans Müller",
        roles: ["sender"],
        actingFor: ["Hausverwaltung Müller"],
      },
      {
        kind: "person",
        name: "Jane Doe",
        roles: ["receiver"],
        actingFor: [],
      },
      {
        kind: "person",
        name: "Erika Muster",
        roles: ["mentioned"],
        actingFor: [],
      },
    ]),
    readBy: {
      model: "vision-model-1",
      address: "https://models.example.net/v1",
      at: "2024-03-02T10:00:00.000Z",
    },
    transcription: { exists: true, complete: true },
  });
  expect(doc.involved).toHaveLength(4);
});

test("a Document still waiting to be read is reported as unread, not as empty", async () => {
  let hash = "";
  const agent = await agentOver(async (library) => {
    hash = await writeDocument(library, {
      filename: "scan.png",
      content: "an unread scan",
    });
  });

  const doc = resultOf(
    await agent.callTool({
      name: "get_document",
      arguments: { hash: hash.slice(0, 12) },
    }),
  );
  expect(doc).toMatchObject({
    hash,
    filename: "scan.png",
    unread: true,
    title: null,
    readBy: null,
    transcription: { exists: false, complete: null },
  });
});

test("each tool that opens a Document says plainly when no Document matches", async () => {
  const agent = await agentOver(async (library) => {
    await writeDocument(library, { filename: "a.pdf", content: "a" });
  });

  for (const name of ["get_document", "get_transcription", "get_original"]) {
    const missing = await agent.callTool({
      name,
      arguments: { hash: "000000000000" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain(
      'No document has the hash "000000000000"',
    );
  }
});

test("get_transcription gives the text, and says when it is incomplete", async () => {
  let complete = "";
  let cut = "";
  let none = "";
  const agent = await agentOver(async (library) => {
    complete = await writeDocument(library, LEASE);
    cut = await writeDocument(library, {
      filename: "long.pdf",
      content: "a long report",
      title: "Annual report",
      transcription: "Chapter one. The year began",
      transcriptionTruncated: true,
    });
    none = await writeDocument(library, {
      filename: "photo.jpg",
      content: "a photo",
      title: "Photo",
    });
  });

  const whole = await agent.callTool({
    name: "get_transcription",
    arguments: { hash: complete },
  });
  expect(resultOf(whole)).toEqual({
    hash: complete,
    text: "Die Kaution beträgt drei Monatsmieten.",
    complete: true,
  });

  const partial = await agent.callTool({
    name: "get_transcription",
    arguments: { hash: cut.slice(0, 12) },
  });
  expect(resultOf(partial)).toMatchObject({
    text: "Chapter one. The year began",
    complete: false,
  });
  expect(textOf(partial)).toContain("incomplete");

  const missing = await agent.callTool({
    name: "get_transcription",
    arguments: { hash: none },
  });
  expect(resultOf(missing)).toEqual({ hash: none, text: null, complete: null });
});

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

test("get_original gives an image as an image and a PDF as a file, each with its media type", async () => {
  let image = "";
  let pdf = "";
  const agent = await agentOver(async (library) => {
    image = await writeDocument(library, {
      filename: "receipt.png",
      content: PIXEL,
      title: "Receipt",
    });
    pdf = await writeDocument(library, LEASE);
  });

  const picture = await agent.callTool({
    name: "get_original",
    arguments: { hash: image.slice(0, 12) },
  });
  expect(picture.content).toEqual([
    {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(PIXEL).toString("base64"),
    },
  ]);

  const file = await agent.callTool({
    name: "get_original",
    arguments: { hash: pdf },
  });
  expect(file.content).toEqual([
    {
      type: "resource",
      resource: {
        uri: `https://zayla.example.com/api/documents/${pdf}/original`,
        mimeType: "application/pdf",
        blob: Buffer.from(LEASE.content).toString("base64"),
      },
    },
  ]);
});

test("list_documents lists Documents newest first, and within a date range when given one", async () => {
  const hashes: Record<string, string> = {};
  const agent = await agentOver(async (library) => {
    for (const [name, date] of [
      ["march", "2024-03-01"],
      ["undated", undefined],
      ["january", "2024-01-15"],
      ["june", "2024-06-30"],
    ] as const)
      hashes[name] = await writeDocument(library, {
        filename: `${name}.pdf`,
        content: name,
        title: `Letter of ${name}`,
        date,
      });
  });

  const all = resultOf(
    await agent.callTool({ name: "list_documents", arguments: {} }),
  );
  expect(all.documents.map((d: { hash: string }) => d.hash)).toEqual([
    hashes.june,
    hashes.march,
    hashes.january,
    hashes.undated,
  ]);
  expect(all.documents[0]).toEqual({
    hash: hashes.june,
    title: "Letter of june",
    date: "2024-06-30",
    sender: null,
    receiver: null,
    unread: false,
  });

  const spring = resultOf(
    await agent.callTool({
      name: "list_documents",
      arguments: { from: "2024-01-15", to: "2024-03-01" },
    }),
  );
  expect(spring.documents.map((d: { hash: string }) => d.hash)).toEqual([
    hashes.march,
    hashes.january,
  ]);

  const later = resultOf(
    await agent.callTool({
      name: "list_documents",
      arguments: { from: "2024-04-01" },
    }),
  );
  expect(later.documents.map((d: { hash: string }) => d.hash)).toEqual([
    hashes.june,
  ]);

  const badDate = await agent.callTool({
    name: "list_documents",
    arguments: { from: "March 2024" },
  });
  expect(badDate.isError).toBe(true);
});

test("an agent is given only tools that read, none that change the Library", async () => {
  const agent = await agentOver(async () => {});

  const { tools } = await agent.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "get_document",
    "get_entity",
    "get_original",
    "get_transcription",
    "list_documents",
    "list_entities",
    "search",
  ]);
  for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
});

test("a prefix more than one Document's hash begins with names neither", async () => {
  const sha = (s: string) =>
    new Bun.CryptoHasher("sha256").update(s).digest("hex");
  // Two contents whose hashes begin alike, as one in sixteen pairs do.
  const first = "letter 0";
  let second = "";
  for (let i = 1; !second; i++)
    if (sha(`letter ${i}`)[0] === sha(first)[0]) second = `letter ${i}`;
  const agent = await agentOver(async (library) => {
    for (const content of [first, second])
      await writeDocument(library, { filename: "a.pdf", content });
  });

  const ambiguous = await agent.callTool({
    name: "get_document",
    arguments: { hash: sha(first)[0] ?? "" },
  });
  expect(ambiguous.isError).toBe(true);
  expect(textOf(ambiguous)).toContain("is the start of 2 documents' hashes");
});
