import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { writeAtomic, writeAtomicSync } from "./store.ts";

const TMP = `/tmp/dm-store-test-${process.pid}`;
const FILE = `${TMP}/file.txt`;

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test("two writes to one file at once both land, and the file holds one of them whole", async () => {
  await mkdir(TMP, { recursive: true });
  const one = "one ".repeat(100_000);
  const two = "two ".repeat(100_000);

  await Promise.all([writeAtomic(FILE, one), writeAtomic(FILE, two)]);

  expect([one, two]).toContain(await Bun.file(FILE).text());
  expect(await readdir(TMP)).toEqual(["file.txt"]);
});

test("a synchronous write lands whole and leaves nothing beside it", async () => {
  await mkdir(TMP, { recursive: true });

  writeAtomicSync(FILE, "whole\n");

  expect(await Bun.file(FILE).text()).toBe("whole\n");
  expect(await readdir(TMP)).toEqual(["file.txt"]);
});
