import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockPath } from "./core/library.ts";

const TMP = `/tmp/dm-cli-test-${process.pid}`; // the library under test
const FIXTURE = join(`/tmp/dm-cli-fix-${process.pid}`, "sample.pdf");

/** Run the CLI against the Library under test. */
async function zayla(...args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), ...args], {
    env: { ...process.env, LIBRARY_DIR: TMP },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** A server holding the Library: a live process whose id is in the lock. */
let server: Bun.Subprocess;

beforeEach(async () => {
  await Bun.write(FIXTURE, "%PDF-1.4\n% minimal test fixture\n");
  await mkdir(TMP, { recursive: true });
  server = Bun.spawn(["sleep", "30"]);
});
afterEach(async () => {
  server.kill();
  await server.exited;
  await rm(TMP, { recursive: true, force: true });
  await rm(join(FIXTURE, ".."), { recursive: true, force: true });
});

const serverHoldsTheLock = () =>
  Bun.write(lockPath(TMP), `pid: ${server.pid}\nby: server\n`);

test("a command that changes the Library refuses while the server holds it, naming the server", async () => {
  await serverHoldsTheLock();

  const { code, stderr } = await zayla("import", FIXTURE);

  expect(code).toBe(1);
  expect(stderr).toContain(`the Zayla server (process ${server.pid})`);
  expect(stderr).toContain(
    "Stop the server, or make this change in the web interface.",
  );
  expect((await zayla("list")).stdout).toContain("(no documents)");
});

test("a command that only reads works while the server holds the Library", async () => {
  await zayla("import", FIXTURE);
  await serverHoldsTheLock();

  const { code, stdout } = await zayla("list");

  expect(code).toBe(0);
  expect(stdout).toContain("sample.pdf");
});

test("a command that changes the Library lets go of it when it fails", async () => {
  const { code } = await zayla("delete", "0".repeat(64));

  expect(code).toBe(1);
  expect(await Bun.file(lockPath(TMP)).exists()).toBe(false);
});
