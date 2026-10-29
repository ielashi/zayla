import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { readYamlFile, writeYamlFile } from "./yaml.ts";

const TMP = `/tmp/dm-yaml-test-${process.pid}`;
const FILE = `${TMP}/document.yaml`;

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const LONG =
  "A lease for the flat on the third floor, running from the first of March for three years, with the rent paid monthly in advance and the deposit held in a separate account.";

test("a file written and read back holds what was written", async () => {
  await mkdir(TMP, { recursive: true });
  const written = {
    filename: "lease.pdf",
    bytes: 1234,
    languages: ["de", "en"],
    sender: { name: "Nordhaus AG", kind: "organization" },
    date: "2024-03-01",
    answer: "no",
    receiver: null,
  };

  await writeYamlFile(FILE, written);

  expect(await readYamlFile(FILE, {})).toEqual(written);
});

test("prose is unquoted, multi-line text is a block, and long lines stay whole", async () => {
  await mkdir(TMP, { recursive: true });

  await writeYamlFile(FILE, {
    title: "Lease: flat, third floor",
    summary: LONG,
    note: "First paragraph.\n\nSecond paragraph.\n",
  });

  const text = await Bun.file(FILE).text();
  expect(text).toContain(`summary: ${LONG}\n`);
  expect(text).toContain(
    "note: |\n  First paragraph.\n\n  Second paragraph.\n",
  );
  // Quoted only where YAML needs it: a colon followed by a space.
  expect(text).toContain('title: "Lease: flat, third floor"\n');
});

test("a field missing from a file reads as its default", async () => {
  await mkdir(TMP, { recursive: true });
  await Bun.write(FILE, "filename: lease.pdf\n");

  expect(
    await readYamlFile(FILE, { filename: "", readingLanguages: ["EN"] }),
  ).toEqual({ filename: "lease.pdf", readingLanguages: ["EN"] });
});

test("a file that isn't there reads as nothing", async () => {
  expect(await readYamlFile(FILE, { filename: "" })).toBeNull();
});

test("an empty file, or one holding no record, is refused rather than read as defaults", async () => {
  await mkdir(TMP, { recursive: true });
  for (const text of ["", "\n", "~\n", "null\n", "- a list\n", "prose\n"]) {
    await Bun.write(FILE, text);
    await expect(readYamlFile(FILE, { filename: "" })).rejects.toThrow(FILE);
  }
});

test("a file that isn't YAML is refused, naming it", async () => {
  await mkdir(TMP, { recursive: true });
  await Bun.write(FILE, "filename: [unclosed\n");
  await expect(readYamlFile(FILE, { filename: "" })).rejects.toThrow(FILE);
});
