import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  newLibrary,
  type RunningZayla,
  signIn,
  startZayla,
  writeDocument,
  writeNaming,
  writeUser,
} from "./library.ts";

let zayla: RunningZayla | null = null;
let library = "";

afterEach(async () => {
  await zayla?.stop();
  zayla = null;
  await rm(library, { recursive: true, force: true });
});

test("a user written as a file signs in with their password and sees the Documents written beside them", async () => {
  library = await newLibrary();
  await writeUser(library, { username: "owner", password: "correct horse" });
  const lease = await writeDocument(library, {
    filename: "lease.pdf",
    content: "a lease",
    title: "Apartment lease",
  });
  const invoice = await writeDocument(library, {
    filename: "invoice.png",
    content: "an invoice",
  });
  zayla = await startZayla(library);

  const listed = await fetch(`${zayla.url}/api/documents`, {
    headers: { Cookie: await signIn(zayla, "correct horse") },
  });
  expect(listed.status).toBe(200);
  const documents = (await listed.json()) as {
    hash: string;
    filename: string;
    title: string | null;
  }[];
  expect(
    documents
      .map(({ hash, filename, title }) => ({ hash, filename, title }))
      .sort((a, b) => a.filename.localeCompare(b.filename)),
  ).toEqual([
    { hash: invoice, filename: "invoice.png", title: null },
    { hash: lease, filename: "lease.pdf", title: "Apartment lease" },
  ]);
});

test("a wrong password is refused", async () => {
  library = await newLibrary();
  await writeUser(library, { username: "owner", password: "correct horse" });
  zayla = await startZayla(library);

  const signingIn = await fetch(`${zayla.url}/api/auth/password/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "battery staple" }),
  });
  expect(signingIn.status).toBe(401);
});

test("a written Transcription and naming are what the server serves", async () => {
  library = await newLibrary();
  await writeUser(library, { username: "owner", password: "correct horse" });
  const lease = await writeDocument(library, {
    filename: "lease.pdf",
    content: "a lease",
    title: "Apartment lease",
    people: ["J. Doe"],
    transcription: "The tenant agrees to pay rent monthly.",
  });
  await writeNaming(library, {
    people: [{ id: 7, name: "Jane Doe", variants: ["Jane Doe", "J. Doe"] }],
  });
  zayla = await startZayla(library);
  const session = await signIn(zayla, "correct horse");

  const transcription = await fetch(
    `${zayla.url}/api/documents/${lease}/transcription`,
    { headers: { Cookie: session } },
  );
  expect(await transcription.text()).toBe(
    "The tenant agrees to pay rent monthly.",
  );

  const person = await fetch(`${zayla.url}/api/entities/7`, {
    headers: { Cookie: session },
  });
  expect(person.status).toBe(200);
  expect(await person.json()).toMatchObject({
    id: 7,
    kind: "person",
    displayName: "Jane Doe",
  });
});
