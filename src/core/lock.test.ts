import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { closeLibrary, openLibrary } from "./db.ts";
import { lockPath } from "./library.ts";
import { LibraryLocked } from "./lock.ts";

const TMP = `/tmp/dm-lock-test-${process.pid}`;

/** Another live process, for as long as the test needs one. */
function anotherProcess() {
  return Bun.spawn(["sleep", "30"]);
}

/** Leave the lock as another process holding the Library would. */
async function lockedBy(pid: number, by: string): Promise<void> {
  await Bun.write(lockPath(TMP), `pid: ${pid}\nby: ${by}\n`);
}

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test("a writer refuses while another live process holds the lock, naming what holds it", async () => {
  const server = anotherProcess();
  try {
    await lockedBy(server.pid, "server");

    let refused: unknown;
    try {
      closeLibrary(openLibrary(TMP, { writer: "import" }));
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(LibraryLocked);
    expect((refused as LibraryLocked).holder).toEqual({
      pid: server.pid,
      by: "server",
    });
  } finally {
    server.kill();
    await server.exited;
  }
});

test("a lock left by a process that no longer exists is taken over", async () => {
  const crashed = anotherProcess();
  crashed.kill();
  await crashed.exited;
  await lockedBy(crashed.pid, "server");

  const lib = openLibrary(TMP, { writer: "import" });
  closeLibrary(lib);

  // Taken over and let go again: the next writer finds the Library free.
  closeLibrary(openLibrary(TMP, { writer: "import" }));
});

test("a second writer in the same process is refused while the first holds the lock", () => {
  const first = openLibrary(TMP, { writer: "server" });
  try {
    expect(() => openLibrary(TMP, { writer: "import" })).toThrow(LibraryLocked);
  } finally {
    closeLibrary(first);
  }
  // Let go of, it is free again.
  closeLibrary(openLibrary(TMP, { writer: "import" }));
});

test("of many processes taking over one stale lock at once, exactly one gets it", async () => {
  const crashed = anotherProcess();
  crashed.kill();
  await crashed.exited;
  await lockedBy(crashed.pid, "server");

  // Each racer waits for the same moment, tries to take the lock, and holds
  // what it got long enough for every other racer to have tried.
  const start = Date.now() + 500;
  const racer = `
    import { takeWriterLock, LibraryLocked } from ${JSON.stringify(`${import.meta.dir}/lock.ts`)};
    while (Date.now() < ${start}) {}
    try {
      const lock = takeWriterLock(${JSON.stringify(TMP)}, "racer");
      console.log("took");
      await Bun.sleep(800);
      lock.release();
    } catch (err) {
      if (!(err instanceof LibraryLocked)) throw err;
      console.log("refused");
    }
  `;
  const racers = Array.from({ length: 12 }, () =>
    Bun.spawn(["bun", "-e", racer], { stdout: "pipe", stderr: "inherit" }),
  );
  const said = await Promise.all(
    racers.map(async (p) => {
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out.trim();
    }),
  );

  expect(said.filter((s) => s === "took")).toHaveLength(1);
  expect(said.filter((s) => s === "refused")).toHaveLength(11);
}, 20_000);

test("a lock left under this process's id by an earlier process is taken over", async () => {
  // A container restarted: the server is process 1 again, and so was the
  // server that crashed holding the lock.
  await lockedBy(process.pid, "server");

  closeLibrary(openLibrary(TMP, { writer: "server" }));
});
